// 群聊大脑的存储层：按「渠道 + 机器人 + 群」隔离的本地数据目录。
//
// 目录布局（root 由调用方给出，通常是 config 的 groupBrainRoot）：
//   <root>/<channel>-<sha256(channel\0botId\0chatId)[0..20]>/messages.jsonl
//                                                              state.json
//                                                              profiles.json
//                                                              memory.md
//
// 约定与仓库其他设置存储保持一致：目录 0700、文件 0600、临时文件 + rename 原子写。
// 本模块只关心「怎么存」，不关心「存什么语义」——群聊大脑的触发、合并、画像编排在
// group-brain 的其他模块里，因此这里不出现任何微信/QQ 专属分支。

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';

/** state.json 的文档版本；升级时用于迁移或保守回退。 */
export const GROUP_STATE_VERSION = 1;

/** profiles.json 的文档版本。 */
export const GROUP_PROFILES_VERSION = 1;

/** 去重集合在 state.json 里保留的最近 messageId 数量。 */
export const MAX_KEPT_MESSAGE_IDS = 500;

/** memory.md 超长截断时加在开头的标记。 */
export const MEMORY_COMPRESSED_MARKER = '（更早记忆已压缩）';

/** recentMessages 判断「文件够小可以整读」的阈值。 */
const RECENT_TAIL_BYTES = 2 * 1024 * 1024;

/** 默认记忆长度上限，与 group-brain-config 的默认值一致。 */
export const DEFAULT_MEMORY_MAX_CHARS = 16_000;

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`group brain store ${name} is required`);
  }
  return value.trim();
}

function numberOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function positiveIntegerOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * 群的存储键：渠道名前缀 + 三元组哈希。
 *
 * 直接用 channel-botId-chatId 做目录名会暴露聊天标识、且可能过长；哈希后既稳定又
 * 不含原值。20 个十六进制字符（80 bit）足以避免同一机器上的意外碰撞。
 */
export function groupStorageKey({ channel, botId, chatId } = {}) {
  const channelName = requireNonEmptyString(channel, 'channel');
  const bot = requireNonEmptyString(botId, 'botId');
  const chat = requireNonEmptyString(chatId, 'chatId');
  const hash = createHash('sha256')
    .update(`${channelName}\0${bot}\0${chat}`)
    .digest('hex')
    .slice(0, 20);
  return `${channelName}-${hash}`;
}

function defaultState({ groupName = '' } = {}) {
  return {
    version: GROUP_STATE_VERSION,
    groupName,
    messageCount: 0,
    firstMessageAt: null,
    lastMessageAt: null,
    memberIds: [],
    // 最近 MAX_KEPT_MESSAGE_IDS 个 messageId：写进 state 是为了跨进程重启后仍能去重。
    messageIds: [],
    lastConsolidatedAt: null,
    updatedAt: null,
  };
}

/**
 * 归一化 state：损坏字段保守回退默认值，但保留未知字段（例如后续编排器写入的
 * 触发游标），避免一升级就丢失扩展数据。
 */
function normalizeState(value, { groupName = '' } = {}) {
  const state = defaultState({ groupName });
  if (!isPlainRecord(value)) return state;
  const known = new Set([
    'version', 'groupName', 'messageCount', 'firstMessageAt', 'lastMessageAt',
    'memberIds', 'messageIds', 'lastConsolidatedAt', 'updatedAt',
  ]);
  for (const [key, entry] of Object.entries(value)) {
    if (known.has(key) || entry === undefined) continue;
    try {
      state[key] = structuredClone(entry);
    } catch {
      // 不会被 JSON 持久化的值（函数等）直接丢弃。
    }
  }
  state.groupName = typeof value.groupName === 'string' && value.groupName.trim()
    ? value.groupName.trim().slice(0, 120)
    : groupName;
  state.messageCount = Number.isSafeInteger(value.messageCount) && value.messageCount > 0
    ? value.messageCount
    : 0;
  state.firstMessageAt = numberOrNull(value.firstMessageAt);
  state.lastMessageAt = numberOrNull(value.lastMessageAt);
  state.memberIds = Array.isArray(value.memberIds)
    ? [...new Set(value.memberIds.filter((id) => typeof id === 'string' && id))]
    : [];
  state.messageIds = Array.isArray(value.messageIds)
    ? value.messageIds
      .filter((id) => typeof id === 'string' && id)
      .slice(-MAX_KEPT_MESSAGE_IDS)
    : [];
  state.lastConsolidatedAt = numberOrNull(value.lastConsolidatedAt);
  state.updatedAt = numberOrNull(value.updatedAt);
  return state;
}

function parseMessageLine(line) {
  const text = line.trim();
  if (!text) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  // 只把「像一条消息」的记录交给调用方：单行损坏不影响整个文件。
  return isPlainRecord(value) && typeof value.messageId === 'string' && value.messageId
    ? value
    : null;
}

/**
 * 一个群的本地存储。同一群的所有读写都经过同一个实例串行化：
 * - 并发 `recordMessage` 不会丢 `messageCount`，也不会因竞态重复追加；
 * - `state.json` 与 `profiles.json` 永远整文件原子替换，读者看不到半截 JSON。
 */
export class GroupBrainStore {
  #root;
  #channel;
  #botId;
  #chatId;
  #initialGroupName;
  #now;
  #logger;
  #directory;
  #state;
  #messageIds;
  #ready = null;
  #queue = Promise.resolve();

  constructor({
    root, channel, botId, chatId, groupName = '', now = Date.now, logger = console,
  } = {}) {
    const base = requireNonEmptyString(root, 'root');
    this.#root = base;
    this.#channel = requireNonEmptyString(channel, 'channel');
    this.#botId = requireNonEmptyString(botId, 'botId');
    this.#chatId = requireNonEmptyString(chatId, 'chatId');
    this.#initialGroupName = typeof groupName === 'string' ? groupName.trim().slice(0, 120) : '';
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#logger = logger ?? console;
    this.#directory = join(base, groupStorageKey({
      channel: this.#channel, botId: this.#botId, chatId: this.#chatId,
    }));
    this.#state = defaultState({ groupName: this.#initialGroupName });
    this.#messageIds = new Set();
  }

  /** 数据目录与四个文件路径；调用方通常只读地用它们做诊断或备份。 */
  get paths() {
    return {
      directory: this.#directory,
      messages: join(this.#directory, 'messages.jsonl'),
      state: join(this.#directory, 'state.json'),
      profiles: join(this.#directory, 'profiles.json'),
      memory: join(this.#directory, 'memory.md'),
    };
  }

  /** 群标识（只读快照）。 */
  get identity() {
    return { channel: this.#channel, botId: this.#botId, chatId: this.#chatId };
  }

  /** 首次调用建立目录并恢复 state；重复调用复用同一个 Promise。 */
  async load() {
    this.#ready ??= this.#initialize().catch((error) => {
      // 失败的初始化不缓存：下一次调用应重试，而不是永远返回同一个错误。
      this.#ready = null;
      throw error;
    });
    await this.#ready;
    return this;
  }

  async #initialize() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    // recursive 只影响新建目录；若目录是早先版本建的，仍收敛到 0700。
    await chmod(this.#directory, 0o700).catch(() => {});
    const state = await this.#readState();
    this.#state = state;
    this.#messageIds = new Set(state.messageIds);
    if (!state.groupName && this.#initialGroupName) {
      this.#state = { ...state, groupName: this.#initialGroupName };
      await this.#writeState();
    }
  }

  async #readState() {
    let raw;
    try {
      raw = await readFile(this.paths.state, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return defaultState({ groupName: this.#initialGroupName });
      this.#warn('state could not be read', error);
      return defaultState({ groupName: this.#initialGroupName });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.#warn('state is not valid JSON', error);
      return defaultState({ groupName: this.#initialGroupName });
    }
    if (!isPlainRecord(parsed)) {
      this.#warn('state is not an object');
      return defaultState({ groupName: this.#initialGroupName });
    }
    return normalizeState(parsed, { groupName: this.#initialGroupName });
  }

  #warn(message, error) {
    try {
      this.#logger.warn?.(`[dsh-im] group brain store: ${message}`, error);
    } catch {
      // 日志本身不能影响存储主流程。
    }
  }

  /** 目录已建好后的原子写：临时文件 0600，rename 覆盖，失败清理临时文件。 */
  async #writeAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #writeState() {
    this.#state = { ...this.#state, updatedAt: this.#now() };
    await this.#writeAtomic(this.paths.state, `${JSON.stringify(this.#state, null, 2)}\n`);
  }

  /** 所有改变 state 的操作走同一条串行化队列（写文件顺序与内存顺序一致）。 */
  #enqueue(task) {
    const run = this.#queue.then(() => task());
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 记录一条群消息；重复 messageId 直接返回而不追加。 */
  async recordMessage({
    messageId, senderId = '', senderName = '', text = '', mentionedBot = false,
    at, kind = 'group', meta = {},
  } = {}) {
    const id = requireNonEmptyString(messageId, 'messageId');
    const when = Number.isFinite(at) ? Math.trunc(at) : Math.trunc(this.#now());
    const record = {
      messageId: id,
      senderId: typeof senderId === 'string' ? senderId : '',
      senderName: typeof senderName === 'string' ? senderName.slice(0, 200) : '',
      text: typeof text === 'string' ? text : '',
      mentionedBot: mentionedBot === true,
      at: when,
      kind: typeof kind === 'string' && kind ? kind : 'group',
      meta: isPlainRecord(meta) ? structuredClone(meta) : {},
    };
    return this.#enqueue(async () => {
      await this.load();
      if (this.#messageIds.has(id)) {
        return { duplicate: true, messageCount: this.#state.messageCount };
      }
      await appendFile(this.paths.messages, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      this.#messageIds.add(id);
      const previous = this.#state;
      const memberIds = [...previous.memberIds];
      if (record.senderId && !memberIds.includes(record.senderId)) memberIds.push(record.senderId);
      this.#state = {
        ...previous,
        groupName: previous.groupName || this.#initialGroupName,
        messageCount: previous.messageCount + 1,
        firstMessageAt: previous.firstMessageAt == null
          ? when
          : Math.min(previous.firstMessageAt, when),
        lastMessageAt: previous.lastMessageAt == null
          ? when
          : Math.max(previous.lastMessageAt, when),
        memberIds,
        messageIds: [...this.#messageIds].slice(-MAX_KEPT_MESSAGE_IDS),
      };
      await this.#writeState();
      return { duplicate: false, messageCount: this.#state.messageCount };
    });
  }

  /** 按时间顺序流式读取 `at >= since` 的消息；达到 limitMessages 立即停止。 */
  async *messagesSince(since, { limitMessages = 100_000 } = {}) {
    await this.load();
    const sinceAt = Number.isFinite(since) ? Math.trunc(since) : 0;
    const limit = positiveIntegerOr(limitMessages, 100_000);
    try {
      await stat(this.paths.messages);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const input = createReadStream(this.paths.messages, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    let yielded = 0;
    try {
      for await (const line of lines) {
        const record = parseMessageLine(line);
        if (!record) continue;
        if (!Number.isFinite(record.at) || record.at < sinceAt) continue;
        yield record;
        yielded += 1;
        if (yielded >= limit) break;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  /**
   * 读取最近 limit 条消息时不整读大文件：超过 2MB 只读尾部，并丢掉第一行（可能是
   * 从半条记录开始的残行）。append-only 的 JSONL 让这个优化不丢最新数据。
   */
  async recentMessages(limit = 50) {
    await this.load();
    const count = positiveIntegerOr(limit, 50);
    let size;
    try {
      size = (await stat(this.paths.messages)).size;
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    if (!size) return [];
    const handle = await open(this.paths.messages, 'r');
    try {
      const start = size > RECENT_TAIL_BYTES ? size - RECENT_TAIL_BYTES : 0;
      const length = size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let text = buffer.toString('utf8');
      if (start > 0) {
        const newline = text.indexOf('\n');
        text = newline >= 0 ? text.slice(newline + 1) : '';
      }
      const records = [];
      for (const line of text.split('\n')) {
        const record = parseMessageLine(line);
        if (record) records.push(record);
      }
      return records.slice(-count);
    } finally {
      await handle.close();
    }
  }

  /** 长期记忆（memory.md）；文件缺失或读取失败时返回空串。 */
  async getMemory() {
    try {
      return await readFile(this.paths.memory, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      this.#warn('memory could not be read', error);
      return '';
    }
  }

  /**
   * 覆盖写入长期记忆。超长时保留最新的一段（末尾）并加「更早记忆已压缩」标记，
   * 而不是丢掉刚发生的对话。返回实际写入的文本，便于调用方同步内存缓存。
   */
  async saveMemory(text, { maxChars = DEFAULT_MEMORY_MAX_CHARS } = {}) {
    if (typeof text !== 'string') throw new TypeError('memory text must be a string');
    const max = positiveIntegerOr(maxChars, DEFAULT_MEMORY_MAX_CHARS);
    const stored = text.length > max
      ? `${MEMORY_COMPRESSED_MARKER}\n${text.slice(text.length - max)}`
      : text;
    await this.load();
    await this.#writeAtomic(this.paths.memory, stored);
    return stored;
  }

  /** 已保存的成员画像表（memberId → 原始画像对象）；损坏时返回空表。 */
  async getProfiles() {
    let raw;
    try {
      raw = await readFile(this.paths.profiles, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      this.#warn('profiles could not be read', error);
      return {};
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.#warn('profiles are not valid JSON', error);
      return {};
    }
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.profiles)) return {};
    return structuredClone(parsed.profiles);
  }

  /** 整表原子替换成员画像；shape 归一化交给 member-profiles 模块。 */
  async saveProfiles(profiles) {
    if (!isPlainRecord(profiles)) throw new TypeError('profiles must be an object');
    for (const value of Object.values(profiles)) {
      if (!isPlainRecord(value)) throw new TypeError('each profile must be an object');
    }
    await this.load();
    const document = { version: GROUP_PROFILES_VERSION, profiles, updatedAt: this.#now() };
    await this.#writeAtomic(this.paths.profiles, `${JSON.stringify(document, null, 2)}\n`);
  }

  /** state 的深拷贝；调用方可以随意读而不影响存储。 */
  async getState() {
    await this.load();
    return structuredClone(this.#state);
  }

  /**
   * 顶层字段合并写（例如 `lastConsolidatedAt`）。未知字段原样保留，用于后续扩展。
   * 返回合并后的 state 深拷贝。
   */
  async updateState(patch) {
    if (!isPlainRecord(patch)) throw new TypeError('state patch must be an object');
    return this.#enqueue(async () => {
      await this.load();
      const merged = { ...structuredClone(this.#state), ...structuredClone(patch) };
      this.#state = normalizeState(merged, { groupName: this.#initialGroupName });
      // messageIds 的归一化不能因为未知字段而丢掉去重集合。
      this.#messageIds = new Set(this.#state.messageIds);
      await this.#writeState();
      return structuredClone(this.#state);
    });
  }

  /** 供诊断/展示的只读摘要。 */
  async getInfo() {
    await this.load();
    return {
      channel: this.#channel,
      botId: this.#botId,
      chatId: this.#chatId,
      groupName: this.#state.groupName,
      memberIds: [...this.#state.memberIds],
      messageCount: this.#state.messageCount,
      lastMessageAt: this.#state.lastMessageAt,
      lastConsolidatedAt: this.#state.lastConsolidatedAt,
    };
  }
}
