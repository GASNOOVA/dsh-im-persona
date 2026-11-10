// 人设的每个机器人持久化存储。
//
// 布局沿用 dshHome 的既有约定（个人版暂不改数据目录，保持与旧数据兼容）：
//
//   <dshHome>/integrations/dsh-im/personas.json
//
// 文档结构（v2；v1 四字段记录读取时自动迁移为 inline）：
//
//   { "version": 2, "personas": { "<botId>": { enabled, source, personaId, name, tone, instructions } } }
//
// 一份文档按 botId 存放所有机器人的人设，因为微信与 QQ 的 botId 全局唯一
// （wx_…/qq_…），一个文件既能让两个渠道互不干扰，也能用一次原子写完成保存，
// 不需要改 bot-workspace-store 的多段持久化签名与版本迁移。
//
// 写入语义与 bot-workspace-store 保持一致：
// - 临时文件 + rename 原子替换，目录 0700、文件 0600；
// - rename 成功之后才更新内存快照，失败时读者继续拿到上一次已提交的值；
// - 同一实例内的写入串行执行，避免并发保存互相覆盖。
//
// 读取语义与“人设损坏不能拖垮机器人”一致：文件缺失静默当空文档；文件损坏或
// 某条记录损坏只降级为默认人设，并保留原文件不重写（下次显式保存才会修复）。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_PERSONA_CONFIG,
  normalizePersonaConfig,
  validatePersonaConfig,
} from './persona.mjs';

/** 人设文档版本：v1=四字段 inline 配置，v2=每机器人库/内联选择。 */
export const PERSONA_DOCUMENT_VERSION = 2;

/** 仍可读取并在内存中迁移的旧文档版本。 */
export const LEGACY_PERSONA_DOCUMENT_VERSIONS = Object.freeze([1]);

/** 与机器人标识的既有约束一致（见 bot-workspace-store 的 botIdOf）。 */
const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 每个 DSH home 只保留一个 store 实例，RPC 与渠道注入共用同一份快照。 */
const stores = new Map();

function invalidBotId() {
  const error = new TypeError('人设的机器人标识无效。');
  error.code = 'persona-invalid-bot';
  return error;
}

function botIdOf(value) {
  if (typeof value !== 'string' || !BOT_ID.test(value)) throw invalidBotId();
  return value;
}

/**
 * 宽容读取整份文档：版本不符或结构损坏返回 null（调用方保留原文件、按空文档
 * 运行）；单条记录损坏只让该机器人回落到默认人设。
 */
function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== PERSONA_DOCUMENT_VERSION
    && !LEGACY_PERSONA_DOCUMENT_VERSIONS.includes(value.version)) return null;
  const raw = value.personas;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const personas = Object.create(null);
  for (const [botId, persona] of Object.entries(raw)) {
    // 键损坏就丢弃这一条；值损坏归一到默认值（该机器人等价于未配置）。
    // v1 四字段记录在这里自动迁移为 v2 inline，不丢用户已有内容。
    if (!BOT_ID.test(botId)) continue;
    personas[botId] = normalizePersonaConfig(persona);
  }
  return personas;
}

/**
 * 按 botId 排序后序列化，让文件内容在多次保存之间稳定（便于 diff 与人工检查）。
 */
function storedDocument(personas) {
  const sorted = Object.create(null);
  for (const botId of Object.keys(personas).sort()) sorted[botId] = personas[botId];
  return { version: PERSONA_DOCUMENT_VERSION, personas: sorted };
}

export class PersonaStore {
  #path;
  #logger;
  #personas = Object.create(null);
  #ready = null;
  #writes = Promise.resolve();

  /**
   * @param path - personas.json 的绝对路径。
   * @param options.logger - 可选日志对象；只用于损坏文档告警。
   */
  constructor(path, { logger } = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('persona store path is required');
    this.#path = path;
    this.#logger = logger ?? console;
  }

  /** 已加载文档的路径；测试与诊断使用。 */
  get path() {
    return this.#path;
  }

  /** 加载文档；重复调用共享同一次读取。 */
  async load() {
    this.#ready ??= this.#load();
    await this.#ready;
    return this;
  }

  /** `load` 的别名，给“必须先有同步快照”的渠道启动路径使用。 */
  async ensureLoaded() {
    return this.load();
  }

  async #load() {
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      // 目录/权限异常不应让机器人启动失败：按空文档运行并留下告警。
      this.#warn('无法读取人设文件，本次以空人设运行', error);
      return;
    }
    let document;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      this.#warn('人设文件不是合法 JSON，本次以空人设运行；保存时会重写该文件', error);
      return;
    }
    const personas = normalizeDocument(document);
    if (personas === null) {
      this.#warn('人设文件结构无效，本次以空人设运行；保存时会重写该文件');
      return;
    }
    this.#personas = personas;
  }

  #warn(message, error) {
    try {
      this.#logger?.warn?.(`[dsh-im] ${message}:`, error?.message ?? error ?? '');
    } catch {
      // 日志失败不能影响读取路径。
    }
  }

  /**
   * 同步读取当前内存快照中某个机器人的配置。
   *
   * 渠道在入站消息受理/组装 prompt 时同步调用它，因此必须在渠道启动时先
   * `ensureLoaded()`；未加载或未知机器人返回默认人设。
   */
  personaFor(botId) {
    let id;
    try {
      id = botIdOf(botId);
    } catch {
      return DEFAULT_PERSONA_CONFIG;
    }
    return this.#personas[id] ?? DEFAULT_PERSONA_CONFIG;
  }

  /** 该机器人是否保存过一份与默认值不同的记录（诊断使用）。 */
  has(botId) {
    try {
      return Object.hasOwn(this.#personas, botIdOf(botId));
    } catch {
      return false;
    }
  }

  /** 异步读取：需要时先加载文档（RPC 的 get 路径使用）。 */
  async get(botId) {
    await this.load();
    return this.personaFor(botId);
  }

  /**
   * 保存一份人设。校验在入队前完成，非法配置不会触达磁盘。
   *
   * @param botId - 机器人标识（`^[A-Za-z0-9_-]{1,128}$`）。
   * @param value - 完整的人设配置（四个字段）。
   * @returns 冻结后的规范化配置。
   */
  async setPersona(botId, value) {
    const id = botIdOf(botId);
    const persona = validatePersonaConfig(value);
    return this.#enqueue(async () => {
      await this.load();
      const next = { ...this.#personas, [id]: persona };
      // 只有 rename 成功后才发布新的内存快照。
      await this.#persist(next);
      this.#personas = next;
      return persona;
    });
  }

  /**
   * 删除一份人设（机器人被移除时调用）。没有记录时不写盘。
   *
   * @returns 是否真的删除了一份记录。
   */
  async clearPersona(botId) {
    const id = botIdOf(botId);
    return this.#enqueue(async () => {
      await this.load();
      if (!Object.hasOwn(this.#personas, id)) return false;
      const next = { ...this.#personas };
      delete next[id];
      await this.#persist(next);
      this.#personas = next;
      return true;
    });
  }

  #enqueue(operation) {
    const run = this.#writes.catch(() => {}).then(operation);
    this.#writes = run;
    return run;
  }

  /** 原子写：临时文件 + rename；失败时临时文件总会被清理。 */
  async #persist(personas) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(storedDocument(personas), null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/**
 * 人设文件路径：`<dshHome>/integrations/dsh-im/personas.json`。
 *
 * 数据目录名沿用 `dsh-im`（不做品牌化），这样旧数据和已有的 dshHome 布局都
 * 不需要迁移；`dshHome` 的解析顺序与 image-input-settings-store 一致。
 */
export function personaStorePath(config = {}) {
  const root = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  return join(root, 'integrations', 'dsh-im', 'personas.json');
}

/**
 * 取当前 DSH home 的人设 store 单例；RPC 安装器与渠道 production 拿到的是
 * 同一个实例，因此保存后下一次入站注入立即读到新值。
 */
export function getPersonaStore(config = {}) {
  const path = personaStorePath(config);
  let store = stores.get(path);
  if (!store) {
    store = new PersonaStore(path);
    stores.set(path, store);
  }
  return store;
}
