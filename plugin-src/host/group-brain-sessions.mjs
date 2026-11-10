// 群聊大脑的「统一会话」登记表。
//
// 需求：同一群聊的所有回复（@ 直通、连续对话、静默接话）都落到同一个 DSH
// 会话里，让模型看到自己之前的发言，形成连贯的群聊上下文，而不是每次新建
// 一个一次性会话。
//
// 登记表按 `<DSH_HOME>/integrations/dsh-im/group-brain/sessions.json` 持久化：
//   { version: 1, sessions: { "<channel>\0<botId>\0<chatId>": { sessionId, ... } } }
// - 读取 fail-soft：文件缺失视为空表，损坏时记录警告并重建；
// - 写入原子：临时文件 + rename，权限 0600；
// - 单进程内按路径缓存实例，所有写入串行化，避免并发覆盖。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { groupBrainRoot } from '../../src/channels/shared/group-brain/group-brain-config.mjs';

export const GROUP_BRAIN_SESSIONS_VERSION = 1;
export const GROUP_BRAIN_SESSIONS_FILENAME = 'sessions.json';

const registries = new Map();

/** 统一会话登记表的默认路径。 */
export function groupBrainSessionsPath(dshHome) {
  return join(groupBrainRoot(dshHome), GROUP_BRAIN_SESSIONS_FILENAME);
}

/** 会话登记键：避免 channel/botId/chatId 里出现分隔符造成碰撞。 */
export function groupBrainSessionKey(channel, botId, chatId) {
  return `${channel}\u0000${botId}\u0000${chatId}`;
}

function cloneRecord(record) {
  return record ? { ...record } : null;
}

export class GroupBrainSessionRegistry {
  #path;
  #logger;
  #data = { version: GROUP_BRAIN_SESSIONS_VERSION, sessions: {} };
  #ready = null;
  #writes = Promise.resolve();

  constructor({ path, logger = console } = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('GroupBrainSessionRegistry requires a path');
    this.#path = path;
    this.#logger = logger;
  }

  get path() {
    return this.#path;
  }

  async load() {
    if (!this.#ready) this.#ready = this.#load();
    return this.#ready;
  }

  async #load() {
    try {
      const text = await readFile(this.#path, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && parsed.version === GROUP_BRAIN_SESSIONS_VERSION && parsed.sessions && typeof parsed.sessions === 'object') {
        this.#data = { version: GROUP_BRAIN_SESSIONS_VERSION, sessions: { ...parsed.sessions } };
      } else {
        this.#logger.warn?.('[dsh-im] group brain session registry has an unsupported shape, starting empty');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#logger.warn?.('[dsh-im] group brain session registry is unreadable, starting empty:', error?.message ?? error);
        this.#ready = null;
      }
      this.#data = { version: GROUP_BRAIN_SESSIONS_VERSION, sessions: {} };
    }
  }

  async get(key) {
    await this.load().catch(() => {});
    return cloneRecord(this.#data.sessions[key]);
  }

  async set(key, record) {
    if (typeof key !== 'string' || !key) throw new TypeError('group brain session key is required');
    if (!record || typeof record.sessionId !== 'string' || !record.sessionId) {
      throw new TypeError('group brain session record requires a sessionId');
    }
    await this.load().catch(() => {});
    const now = new Date().toISOString();
    this.#data.sessions[key] = {
      ...record,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
      updatedAt: now,
    };
    await this.#save();
  }

  async delete(key) {
    await this.load().catch(() => {});
    if (!(key in this.#data.sessions)) return false;
    delete this.#data.sessions[key];
    await this.#save();
    return true;
  }

  async list() {
    await this.load().catch(() => {});
    return Object.entries(this.#data.sessions).map(([key, record]) => ({ key, ...record }));
  }

  #save() {
    const run = this.#writes.then(() => this.#writeFile(), () => this.#writeFile());
    this.#writes = run.catch(() => {});
    return run;
  }

  async #writeFile() {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(this.#data)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, this.#path);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}

/**
 * 进程内按路径共享同一个登记表实例。
 * @param {{ dshHome?: string, path?: string, logger?: object }} options
 */
export function getGroupBrainSessionRegistry({ dshHome, path = null, logger = console } = {}) {
  const resolvedPath = path ?? groupBrainSessionsPath(dshHome);
  let registry = registries.get(resolvedPath);
  if (!registry) {
    registry = new GroupBrainSessionRegistry({ path: resolvedPath, logger });
    registries.set(resolvedPath, registry);
  }
  return registry;
}

/** 测试清理：移除缓存实例（不删除磁盘文件）。 */
export function clearGroupBrainSessionRegistries() {
  registries.clear();
}
