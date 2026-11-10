// 人设库：内置人设（builtin）+ 用户导入项（imported）+ 可选 config 文件条目（config）。
//
// 持久化：`<DSH_HOME>/integrations/dsh-im/persona-library.json`，与每机器人人设
// 的 personas.json 分开：库是「可复用的角色素材」，personas.json 只保存每个机器人
// 选了哪个库条目（或自己的内联配置）。
//
// 约定：
// - builtin（当前只有「大肥鱼」）与 config 条目只读：不可删除、不可重命名；
// - imported 条目由设置页导入（粘贴正文或本地 .md/.markdown/.txt 文件），
//   名字 ≤60、正文 ≤64,000 字符，最多保留 200 条；
// - list 只返回元数据（id/name/description/source/readonly），正文按需 get，
//   避免设置页一次拉取所有长文；
// - 原子写与 personas.json 一致：临时文件 + rename，失败时保留上一次已提交快照；
// - 文件损坏/非法 JSON 时以「只有 builtin」的库运行并保留原文件，下次显式写才修复；
// - config `personaFile`（绝对路径）读取失败只告警，不影响内置与导入项。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

import { PERSONA_PRESETS, personaPresetFor } from './persona-presets.mjs';
import {
  PERSONA_LIBRARY_ID_PATTERN,
  PERSONA_LIBRARY_NAME_MAX_LENGTH,
  PERSONA_LIBRARY_TEXT_MAX_LENGTH,
} from './persona.mjs';

/** 人设库文档版本。 */
export const PERSONA_LIBRARY_DOCUMENT_VERSION = 1;

/** 人设来源：builtin / imported / config。 */
export const PERSONA_LIBRARY_SOURCES = Object.freeze(['builtin', 'imported', 'config']);

/** config 文件条目的固定 id。 */
export const PERSONA_CONFIG_PERSONA_ID = 'config';

/** 最多保留的导入条目数，避免库文件无限增长。 */
export const PERSONA_LIBRARY_MAX_ENTRIES = 200;

const CONFIG_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

const stores = new Map();

function invalidLibrary(message, code = 'persona-library-invalid') {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 与 personas 一致的清洗：CRLF 归一、控制字符剔除、首尾 trim。 */
function cleanText(value) {
  return value.replace(/\r\n?/g, '\n').replace(UNSAFE_TEXT, '').trim();
}

/** 校验导入/重命名输入：名字 ≤60、正文 ≤64,000，均不能为空。 */
export function validateLibraryEntryInput(input) {
  if (!isPlainRecord(input) || Object.keys(input).length !== 2
    || !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'text')) {
    throw invalidLibrary('请提交完整的人设名称与正文。');
  }
  if (typeof input.name !== 'string') throw invalidLibrary('人设名称必须是文本。');
  if (typeof input.text !== 'string') throw invalidLibrary('人设正文必须是文本。');
  const name = cleanText(input.name);
  const text = cleanText(input.text);
  if (!name) throw invalidLibrary('人设名称不能为空。');
  if (name.length > PERSONA_LIBRARY_NAME_MAX_LENGTH) {
    throw invalidLibrary(`人设名称不能超过 ${PERSONA_LIBRARY_NAME_MAX_LENGTH} 个字符。`);
  }
  if (!text) throw invalidLibrary('人设正文不能为空。');
  if (text.length > PERSONA_LIBRARY_TEXT_MAX_LENGTH) {
    throw invalidLibrary(`人设正文不能超过 ${PERSONA_LIBRARY_TEXT_MAX_LENGTH} 个字符。`);
  }
  return Object.freeze({ name, text });
}

/** 校验重命名输入。 */
export function validateLibraryName(value) {
  return validateLibraryEntryInput({ name: value, text: '占位' }).name;
}

/** 一行简介：取正文第一行，去掉 Markdown 标题/列表标记，截断到 120 字符。 */
export function describePersonaLibraryText(text) {
  if (typeof text !== 'string') return '';
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const plain = first.replace(/^#{1,6}\s*/u, '').replace(/^[-*+]\s+/u, '');
  return plain.length > 120 ? `${plain.slice(0, 119)}…` : plain;
}

function normalizeDocument(value) {
  if (!isPlainRecord(value)) return null;
  if (value.version !== PERSONA_LIBRARY_DOCUMENT_VERSION) return null;
  if (!isPlainRecord(value.entries) || Array.isArray(value.entries)) return null;
  const entries = Object.create(null);
  for (const [id, entry] of Object.entries(value.entries)) {
    if (!PERSONA_LIBRARY_ID_PATTERN.test(id) || id === PERSONA_CONFIG_PERSONA_ID) continue;
    if (!isPlainRecord(entry)) continue;
    try {
      const validated = validateLibraryEntryInput({ name: entry.name, text: entry.text });
      entries[id] = {
        name: validated.name,
        text: validated.text,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
      };
    } catch {
      // 单条损坏只丢弃该条，库仍可用。
    }
  }
  return entries;
}

function storedDocument(imported) {
  const entries = Object.create(null);
  for (const id of Object.keys(imported).sort()) entries[id] = imported[id];
  return { version: PERSONA_LIBRARY_DOCUMENT_VERSION, entries };
}

function metadata(entry) {
  return Object.freeze({
    id: entry.id,
    name: entry.name,
    description: entry.description ?? '',
    source: entry.source,
    readonly: entry.source !== 'imported',
  });
}

export class PersonaLibrary {
  #path;
  #configFile;
  #builtins;
  #logger;
  #imported = Object.create(null);
  #configEntry = null;
  #ready = null;
  #writes = Promise.resolve();

  /**
   * @param path - persona-library.json 绝对路径。
   * @param options.configFile - 可选的 config `personaFile` 绝对路径。
   * @param options.builtins - 内置人设清单（测试可注入）。
   */
  constructor(path, { configFile = '', builtins = PERSONA_PRESETS, logger } = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('persona library path is required');
    this.#path = path;
    this.#configFile = typeof configFile === 'string' ? configFile.trim() : '';
    this.#builtins = builtins;
    this.#logger = logger ?? console;
  }

  get path() {
    return this.#path;
  }

  async load() {
    this.#ready ??= this.#load().catch((error) => {
      this.#ready = null;
      throw error;
    });
    await this.#ready;
    return this;
  }

  async #warn(message, error) {
    try {
      this.#logger?.warn?.(`[dsh-im] ${message}:`, error?.message ?? error ?? '');
    } catch {
      // 日志失败不影响读取路径。
    }
  }

  async #load() {
    // 先读导入项；损坏时以空库运行并保留文件。
    try {
      const raw = await readFile(this.#path, 'utf8');
      let document;
      try {
        document = JSON.parse(raw);
      } catch (error) {
        await this.#warn('人设库文件不是合法 JSON，本次只加载内置人设；保存时会重写该文件', error);
        document = null;
      }
      if (document !== null) {
        const imported = normalizeDocument(document);
        if (imported === null) {
          await this.#warn('人设库文件结构无效，本次只加载内置人设；保存时会重写该文件');
        } else {
          this.#imported = imported;
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        await this.#warn('无法读取人设库文件，本次只加载内置人设', error);
      }
    }
    // 再读 config personaFile；失败只告警。
    if (this.#configFile) {
      try {
        if (!isAbsolute(this.#configFile)) throw new TypeError('personaFile 必须是绝对路径');
        const text = cleanText(await readFile(this.#configFile, 'utf8'));
        if (!text) throw new TypeError('personaFile 内容为空');
        const base = basename(this.#configFile);
        const name = base.slice(0, base.length - extname(base).length) || PERSONA_CONFIG_PERSONA_ID;
        this.#configEntry = Object.freeze({
          id: PERSONA_CONFIG_PERSONA_ID,
          name: name.slice(0, PERSONA_LIBRARY_NAME_MAX_LENGTH),
          text: text.slice(0, PERSONA_LIBRARY_TEXT_MAX_LENGTH),
          source: 'config',
          description: describePersonaLibraryText(text),
          file: resolve(this.#configFile),
        });
      } catch (error) {
        await this.#warn('personaFile 不可读或无效，已忽略 config 人设', error);
      }
    }
  }

  #builtinEntry(id) {
    const preset = typeof personaPresetFor === 'function'
      ? personaPresetFor(id) : this.#builtins.find((item) => item.id === id) ?? null;
    return preset
      ? Object.freeze({
        id: preset.id,
        name: preset.name,
        text: preset.text,
        source: 'builtin',
        description: preset.description ?? describePersonaLibraryText(preset.text),
      })
      : null;
  }

  /** 同步读取库条目（注入解析用）：builtin / config / imported，缺失返回 null。 */
  entryFor(id) {
    if (typeof id !== 'string' || !id) return null;
    if (!this.#ready) return null;
    const builtin = this.#builtinEntry(id);
    if (builtin) return builtin;
    if (id === PERSONA_CONFIG_PERSONA_ID) return this.#configEntry;
    const entry = this.#imported[id];
    if (!entry) return null;
    return Object.freeze({
      id,
      name: entry.name,
      text: entry.text,
      source: 'imported',
      description: describePersonaLibraryText(entry.text),
      updatedAt: entry.updatedAt,
    });
  }

  /** 元数据列表：builtin → config → imported（按更新时间倒序）。 */
  list() {
    const items = [];
    for (const preset of this.#builtins) {
      items.push(metadata({
        id: preset.id,
        name: preset.name,
        description: preset.description ?? describePersonaLibraryText(preset.text),
        source: 'builtin',
      }));
    }
    if (this.#configEntry) items.push(metadata(this.#configEntry));
    for (const [id, entry] of Object.entries(this.#imported)) {
      items.push(metadata({
        id,
        name: entry.name,
        description: describePersonaLibraryText(entry.text),
        source: 'imported',
        updatedAt: entry.updatedAt,
      }));
    }
    return items;
  }

  /** 单条完整内容（按需拉取正文）。 */
  async get(id) {
    await this.load();
    const entry = this.entryFor(id);
    if (!entry) throw invalidLibrary('人设不存在。', 'persona-library-not-found');
    return { ...metadata(entry), name: entry.name, text: entry.text };
  }

  /** 导入一条人设（粘贴或来自浏览器读取的文件文本）。 */
  async importEntry(input) {
    const { name, text } = validateLibraryEntryInput(input);
    return this.#enqueue(async () => {
      await this.load();
      if (Object.keys(this.#imported).length >= PERSONA_LIBRARY_MAX_ENTRIES) {
        throw invalidLibrary(`最多保存 ${PERSONA_LIBRARY_MAX_ENTRIES} 条导入人设，请先删除不用的。`, 'persona-library-limit');
      }
      const now = new Date().toISOString();
      let id;
      do {
        id = `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      } while (this.entryFor(id));
      const next = { ...this.#imported, [id]: { name, text, createdAt: now, updatedAt: now } };
      await this.#persist(next);
      this.#imported = next;
      return this.get(id);
    });
  }

  /** 重命名导入项；builtin/config 只读。 */
  async rename(id, value) {
    const name = validateLibraryName(value);
    return this.#enqueue(async () => {
      await this.load();
      this.#assertWritable(id);
      const next = {
        ...this.#imported,
        [id]: { ...this.#imported[id], name, updatedAt: new Date().toISOString() },
      };
      await this.#persist(next);
      this.#imported = next;
      return this.get(id);
    });
  }

  /** 删除导入项；builtin/config 只读。 */
  async remove(id) {
    return this.#enqueue(async () => {
      await this.load();
      this.#assertWritable(id);
      const next = { ...this.#imported };
      delete next[id];
      await this.#persist(next);
      this.#imported = next;
      return true;
    });
  }

  #assertWritable(id) {
    if (typeof id !== 'string' || !PERSONA_LIBRARY_ID_PATTERN.test(id)) {
      throw invalidLibrary('人设不存在。', 'persona-library-not-found');
    }
    if (id === PERSONA_CONFIG_PERSONA_ID || this.#builtinEntry(id)) {
      throw invalidLibrary(
        id === PERSONA_CONFIG_PERSONA_ID
          ? 'config 人设由插件配置提供，不可修改。'
          : '内置人设不可修改。',
        'persona-library-readonly',
      );
    }
    if (!this.#imported[id]) throw invalidLibrary('人设不存在。', 'persona-library-not-found');
  }

  #enqueue(operation) {
    const run = this.#writes.catch(() => {}).then(operation);
    this.#writes = run;
    return run;
  }

  async #persist(imported) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(storedDocument(imported), null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** 人设库文件路径：`<DSH_HOME>/integrations/dsh-im/persona-library.json`。 */
export function personaLibraryPath(config = {}) {
  const root = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  return join(root, 'integrations', 'dsh-im', 'persona-library.json');
}

/**
 * 当前 DSH home 的人设库单例。config `personaFile` 决定可选的 config 条目；
 * 同路径不同 personaFile 视为不同实例（config 条目不同）。
 */
export function getPersonaLibrary(config = {}) {
  const path = personaLibraryPath(config);
  const configFile = typeof config.personaFile === 'string' ? config.personaFile.trim() : '';
  const key = `${path}\u0000${configFile}`;
  let library = stores.get(key);
  if (!library) {
    library = new PersonaLibrary(path, { configFile });
    stores.set(key, library);
  }
  return library;
}
