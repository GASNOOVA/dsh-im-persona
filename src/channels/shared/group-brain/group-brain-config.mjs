// 群聊大脑全局配置：开关、小群成员上限、自动接话参数、长期记忆压缩间隔、画像开关。
//
// 这是渠道无关的配置：微信群（个人号桥接）与 QQ 群共用同一套策略；具体到某个群是否
// 允许自动接话，由 allowedGroups（白名单）或群成员数（≤ maxMembers）决定。
//
// 持久化：`<DSH_HOME>/integrations/dsh-im/group-brain-settings.json`，与 persona 等
// 设置一致：目录 0700、文件 0600、临时文件 + rename 原子写、损坏时保守回退默认值。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 配置文档版本。 */
export const GROUP_BRAIN_DOCUMENT_VERSION = 1;

/** 配置文件名。 */
export const GROUP_BRAIN_SETTINGS_FILENAME = 'group-brain-settings.json';

/** 默认配置：群聊大脑开启，但自动接话只对白名单群或已知 ≤5 人群生效。 */
export const DEFAULT_GROUP_BRAIN_SETTINGS = Object.freeze({
  version: GROUP_BRAIN_DOCUMENT_VERSION,
  enabled: true,
  maxMembers: 5,
  allowedGroups: Object.freeze([]),
  ambient: Object.freeze({
    enabled: true,
    silenceMs: 120_000,
    minMessages: 2,
    cooldownMs: 600_000,
    maxPerHour: 4,
    maxPerDay: 40,
  }),
  memory: Object.freeze({
    consolidateIntervalDays: 30,
    segmentGapMs: 600_000,
    maxMemoryChars: 16_000,
  }),
  profiles: Object.freeze({
    enabled: true,
    maxProfiles: 5,
  }),
});

/** 配置字段的合法范围（闭区间，整数）。 */
export const GROUP_BRAIN_LIMITS = Object.freeze({
  maxMembers: Object.freeze([2, 50]),
  silenceMs: Object.freeze([30_000, 3_600_000]),
  minMessages: Object.freeze([1, 50]),
  cooldownMs: Object.freeze([60_000, 86_400_000]),
  maxPerHour: Object.freeze([1, 30]),
  maxPerDay: Object.freeze([1, 300]),
  consolidateIntervalDays: Object.freeze([1, 365]),
  segmentGapMs: Object.freeze([60_000, 86_400_000]),
  maxMemoryChars: Object.freeze([2_000, 64_000]),
  maxProfiles: Object.freeze([1, 20]),
});

/** allowedGroups 最多条目数。 */
export const GROUP_BRAIN_MAX_ALLOWED_GROUPS = 50;

const stores = new Map();

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidInteger(value, [min, max]) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function readInteger(value, fallback, range) {
  return isValidInteger(value, range) ? value : fallback;
}

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** 归一化单个白名单群：channel/botId/chatId 必填，groupName 可省略。 */
export function normalizeAllowedGroup(value) {
  if (!isPlainRecord(value)) return null;
  const channel = normalizeText(value.channel, 32);
  const botId = normalizeText(value.botId, 200);
  const chatId = normalizeText(value.chatId, 200);
  if (!channel || !botId || !chatId) return null;
  const groupName = normalizeText(value.groupName, 120);
  return Object.freeze({ channel, botId, chatId, groupName });
}

/**
 * 归一化完整配置。接受任何形状的输入：
 * - 缺失/非法字段回退默认值（保守，不因手工改坏文件而失联）；
 * - 只有 `value` 完全不是对象时返回 null，表示文件损坏需要告警。
 */
export function normalizeGroupBrainSettings(value) {
  if (!isPlainRecord(value)) return null;
  const defaults = DEFAULT_GROUP_BRAIN_SETTINGS;

  const allowedGroups = [];
  if (Array.isArray(value.allowedGroups)) {
    const seen = new Set();
    for (const raw of value.allowedGroups) {
      const group = normalizeAllowedGroup(raw);
      if (!group) continue;
      const key = `${group.channel}\u0000${group.botId}\u0000${group.chatId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allowedGroups.push(group);
      if (allowedGroups.length >= GROUP_BRAIN_MAX_ALLOWED_GROUPS) break;
    }
  }

  const ambient = isPlainRecord(value.ambient) ? value.ambient : {};
  const memory = isPlainRecord(value.memory) ? value.memory : {};
  const profiles = isPlainRecord(value.profiles) ? value.profiles : {};

  return Object.freeze({
    version: GROUP_BRAIN_DOCUMENT_VERSION,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
    maxMembers: readInteger(value.maxMembers, defaults.maxMembers, GROUP_BRAIN_LIMITS.maxMembers),
    allowedGroups: Object.freeze(allowedGroups),
    ambient: Object.freeze({
      enabled: typeof ambient.enabled === 'boolean' ? ambient.enabled : defaults.ambient.enabled,
      silenceMs: readInteger(ambient.silenceMs, defaults.ambient.silenceMs, GROUP_BRAIN_LIMITS.silenceMs),
      minMessages: readInteger(ambient.minMessages, defaults.ambient.minMessages, GROUP_BRAIN_LIMITS.minMessages),
      cooldownMs: readInteger(ambient.cooldownMs, defaults.ambient.cooldownMs, GROUP_BRAIN_LIMITS.cooldownMs),
      maxPerHour: readInteger(ambient.maxPerHour, defaults.ambient.maxPerHour, GROUP_BRAIN_LIMITS.maxPerHour),
      maxPerDay: readInteger(ambient.maxPerDay, defaults.ambient.maxPerDay, GROUP_BRAIN_LIMITS.maxPerDay),
    }),
    memory: Object.freeze({
      consolidateIntervalDays: readInteger(
        memory.consolidateIntervalDays,
        defaults.memory.consolidateIntervalDays,
        GROUP_BRAIN_LIMITS.consolidateIntervalDays,
      ),
      segmentGapMs: readInteger(memory.segmentGapMs, defaults.memory.segmentGapMs, GROUP_BRAIN_LIMITS.segmentGapMs),
      maxMemoryChars: readInteger(memory.maxMemoryChars, defaults.memory.maxMemoryChars, GROUP_BRAIN_LIMITS.maxMemoryChars),
    }),
    profiles: Object.freeze({
      enabled: typeof profiles.enabled === 'boolean' ? profiles.enabled : defaults.profiles.enabled,
      maxProfiles: readInteger(profiles.maxProfiles, defaults.profiles.maxProfiles, GROUP_BRAIN_LIMITS.maxProfiles),
    }),
  });
}

/** 判断某个群是否在自动接话白名单内。 */
export function isGroupAllowed(settings, { channel, botId, chatId } = {}) {
  if (!settings || !Array.isArray(settings.allowedGroups)) return false;
  return settings.allowedGroups.some((group) => group.channel === channel
    && group.botId === botId
    && group.chatId === chatId);
}

/** 计算群聊大脑数据根目录。 */
export function groupBrainRoot(dshHome) {
  const home = resolve(dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'));
  return join(home, 'integrations', 'dsh-im', 'group-brain');
}

/** 计算配置文件路径。 */
export function groupBrainSettingsPath(dshHome) {
  const home = resolve(dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'));
  return join(home, 'integrations', 'dsh-im', GROUP_BRAIN_SETTINGS_FILENAME);
}

/** 群聊大脑全局配置存储：懒加载、原子写、按路径单例。 */
export class GroupBrainSettingsStore {
  #path;
  #settings = DEFAULT_GROUP_BRAIN_SETTINGS;
  #ready = null;
  #writes = Promise.resolve();

  constructor({ path } = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('group brain settings path is required');
    this.#path = path;
  }

  get path() {
    return this.#path;
  }

  async get() {
    if (!this.#ready) {
      this.#ready = this.#load().catch((error) => {
        this.#ready = null;
        throw error;
      });
    }
    await this.#ready;
    return this.#settings;
  }

  async #load() {
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#settings = DEFAULT_GROUP_BRAIN_SETTINGS;
        return;
      }
      throw error;
    }
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      throw new Error('群聊大脑设置文件不是合法 JSON。');
    }
    const normalized = normalizeGroupBrainSettings(document);
    if (!normalized) throw new Error('群聊大脑设置文件结构不合法。');
    this.#settings = normalized;
  }

  async set(value) {
    const normalized = normalizeGroupBrainSettings(value);
    if (!normalized) throw new TypeError('群聊大脑设置结构不合法。');
    this.#writes = this.#writes.then(() => this.#write(normalized));
    await this.#writes;
    this.#settings = normalized;
    this.#ready = Promise.resolve();
    return normalized;
  }

  async #write(settings) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

/** 取得（或创建）某个 dshHome 对应的配置存储单例。 */
export function getGroupBrainSettingsStore(config = {}) {
  const path = groupBrainSettingsPath(config.dshHome);
  let store = stores.get(path);
  if (!store) {
    store = new GroupBrainSettingsStore({ path });
    stores.set(path, store);
  }
  return store;
}
