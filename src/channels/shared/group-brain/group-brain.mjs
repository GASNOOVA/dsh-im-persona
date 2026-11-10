// 群聊大脑编排器（channel-agnostic）。
//
// 负责把一个群里的消息流，变成三种能力：
// 1) 长期记录：每条群消息落到 `<DSH_HOME>/integrations/dsh-im/group-brain/<群目录>/messages.jsonl`；
// 2) 被 @ 时：给宿主返回注入块（明确指令 + 群里长期记忆/成员画像），由调用方拼进用户消息；
// 3) 未 @ 时：交给 GroupTriggerEngine 判断「话题停顿」时机，再用注入的 generate/send 主动接一句；
//    默认安静，只有白名单群或已知 ≤ maxMembers 人的小群才会触发。
//
// 另外按 memory.consolidateIntervalDays（默认 30 天）把原始记录交给模型压缩成
// memory.md + profiles.json，避免长期记忆文件无限增长。
//
// 本模块不直接依赖任何渠道；宿主的 weixin/qq 适配层只需要在收到群消息时调用
// observe()，被 @ 时把返回的 blocks 拼进用户消息即可。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_GROUP_BRAIN_SETTINGS,
  getGroupBrainSettingsStore,
  groupBrainRoot,
  isGroupAllowed,
} from './group-brain-config.mjs';
import { GroupBrainStore } from './group-store.mjs';
import { GroupMemberProfiles } from './member-profiles.mjs';
import { GroupTriggerEngine, normalizeGroupTriggerSettings } from './group-trigger.mjs';
import {
  buildAmbientPrompt,
  buildConsolidationPrompt,
  buildDirectInstructionBlock,
  buildGroupMemoryBlock,
  parseAmbientResult,
  parseConsolidationResult,
} from './group-context.mjs';

/** 群注册表文件名（记录 brain 见过的群，便于重启后继续压缩记忆）。 */
export const GROUP_BRAIN_REGISTRY_FILENAME = 'groups.json';

/** 注册表文档版本。 */
export const GROUP_BRAIN_REGISTRY_VERSION = 1;

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const MAX_MESSAGE_TEXT = 4_000;
const MAX_GROUP_NAME = 120;
const MAX_MEMBER_COUNT = 5_000;
const AMBIENT_SEGMENT_LIMIT = 30;
const AMBIENT_PROMPT_MESSAGE_LIMIT = 200;
const CONSOLIDATION_MESSAGE_LIMIT = 1_500;
const CONSOLIDATION_CHAR_LIMIT = 64_000;
const DIRECT_MEMORY_MAX_CHARS = 6_000;
const MAX_AMBIENT_REPLY_CHARS = 500;

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, maxLength = MAX_MESSAGE_TEXT) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim().slice(0, maxLength);
}

function cleanOneLine(value, maxLength) {
  return cleanText(value, maxLength).replace(/\s+/g, ' ').trim();
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 群聊大脑。
 *
 * 调用方（宿主渠道适配层）负责提供：
 * - channel / botId：用于隔离不同机器人；
 * - generate({kind, prompt, meta})：执行一次模型生成（ambient / consolidate）；
 * - send({chatId, text, meta})：把主动消息发到群里（仅自动接话需要）；
 * - resolvePersona()：返回当前机器人已解析的人设 `{enabled,name,text}` 或 null；
 * - dshHome 或 root：数据目录。
 */
export class GroupBrain {
  #channel;
  #botId;
  #root;
  #settingsStore;
  #settings = null;
  #generate;
  #send;
  #resolvePersona;
  #sessionExists = null;
  #logger;
  #now;
  #timerFns;
  #storeFactory;
  #profilesFactory;
  #stores = new Map();
  #profiles = new Map();
  #groups = new Map();
  #trigger = null;
  #started = false;
  #consolidationTimer = null;
  #queues = new Map();
  #registryReady = null;

  constructor({
    channel,
    botId,
    dshHome,
    root,
    settingsStore,
    generate,
    send = null,
    resolvePersona = null,
    sessionExists = null,
    logger = console,
    now = () => Date.now(),
    timerFns = {},
    storeFactory = null,
    profilesFactory = null,
  } = {}) {
    if (typeof channel !== 'string' || !channel) throw new TypeError('group brain channel is required');
    if (typeof botId !== 'string' || !botId) throw new TypeError('group brain botId is required');
    if (typeof generate !== 'function') throw new TypeError('group brain generate function is required');
    this.#channel = channel;
    this.#botId = botId;
    this.#root = root ?? groupBrainRoot(dshHome);
    this.#settingsStore = settingsStore ?? getGroupBrainSettingsStore({ dshHome });
    this.#generate = generate;
    this.#send = typeof send === 'function' ? send : null;
    this.#resolvePersona = typeof resolvePersona === 'function' ? resolvePersona : null;
    this.#sessionExists = typeof sessionExists === 'function' ? sessionExists : null;
    this.#logger = logger ?? console;
    this.#now = now;
    this.#timerFns = {
      setTimeout: timerFns.setTimeout ?? setTimeout,
      clearTimeout: timerFns.clearTimeout ?? clearTimeout,
      setInterval: timerFns.setInterval ?? setInterval,
      clearInterval: timerFns.clearInterval ?? clearInterval,
    };
    this.#storeFactory = storeFactory
      ?? ((options) => new GroupBrainStore(options));
    this.#profilesFactory = profilesFactory
      ?? ((options) => new GroupMemberProfiles(options));
  }

  get channel() {
    return this.#channel;
  }

  get botId() {
    return this.#botId;
  }

  get root() {
    return this.#root;
  }

  /** 读取配置与注册表，并构建触发引擎；不启动定时器。 */
  async load() {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await this.#loadSettings();
    await this.#loadRegistry();
    this.#rebuildTrigger();
  }

  /** 加载并启动后台记忆压缩定时器，同时补一次到期检查。 */
  async start() {
    await this.load();
    if (this.#started) return;
    this.#started = true;
    this.#scheduleConsolidation();
    await this.maybeConsolidateAll().catch((error) => {
      this.#logger.warn?.('[dsh-im] group brain consolidation check failed:', error);
    });
  }

  /** 配置被其它进程/设置页修改后重新加载。 */
  async reloadSettings() {
    await this.#loadSettings();
    this.#rebuildTrigger();
    return this.#settings;
  }

  async #loadSettings() {
    try {
      this.#settings = await this.#settingsStore.get();
    } catch (error) {
      this.#logger.warn?.('[dsh-im] group brain settings unavailable, using defaults:', error);
      this.#settings = DEFAULT_GROUP_BRAIN_SETTINGS;
    }
    return this.#settings;
  }

  #currentSettings() {
    return this.#settings ?? DEFAULT_GROUP_BRAIN_SETTINGS;
  }

  #rebuildTrigger() {
    try {
      this.#trigger?.dispose?.();
    } catch {
      // 旧引擎清理失败不影响新引擎。
    }
    const settings = this.#currentSettings();
    const triggerSettings = normalizeGroupTriggerSettings(settings.ambient)
      ?? normalizeGroupTriggerSettings({});
    this.#trigger = new GroupTriggerEngine({
      settings: triggerSettings,
      now: this.#now,
      setTimeoutFn: this.#timerFns.setTimeout,
      clearTimeoutFn: this.#timerFns.clearTimeout,
      onAmbient: (chatId, info) => {
        void this.#handleAmbient(chatId, info).catch((error) => {
          this.#logger.warn?.('[dsh-im] group ambient reply failed:', error);
        });
      },
      logger: this.#logger,
    });
  }

  #scheduleConsolidation() {
    if (this.#consolidationTimer) return;
    const intervalMs = 60 * 60 * 1_000;
    const timer = this.#timerFns.setInterval(() => {
      void this.maybeConsolidateAll().catch((error) => {
        this.#logger.warn?.('[dsh-im] group brain consolidation failed:', error);
      });
    }, intervalMs);
    timer?.unref?.();
    this.#consolidationTimer = timer;
  }

  // ---------------------------------------------------------------------------
  // 群注册表
  // ---------------------------------------------------------------------------

  async #loadRegistry() {
    if (!this.#registryReady) this.#registryReady = this.#readRegistry();
    await this.#registryReady;
  }

  async #readRegistry() {
    const path = join(this.#root, GROUP_BRAIN_REGISTRY_FILENAME);
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#logger.warn?.('[dsh-im] group brain registry read failed:', error);
      }
      return;
    }
    let document;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      this.#logger.warn?.('[dsh-im] group brain registry is not valid JSON:', error);
      return;
    }
    if (!isPlainRecord(document) || document.version !== GROUP_BRAIN_REGISTRY_VERSION
      || !Array.isArray(document.groups)) return;
    for (const rawGroup of document.groups) {
      this.#upsertGroupRecord(rawGroup, { save: false });
    }
  }

  async #saveRegistry() {
    const path = join(this.#root, GROUP_BRAIN_REGISTRY_FILENAME);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify({
        version: GROUP_BRAIN_REGISTRY_VERSION,
        groups: [...this.#groups.values()],
      }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      this.#logger.warn?.('[dsh-im] group brain registry write failed:', error);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  #upsertGroupRecord(raw, { save = true } = {}) {
    if (!isPlainRecord(raw)) return null;
    const channel = cleanOneLine(raw.channel, 32) || this.#channel;
    const botId = cleanOneLine(raw.botId, 200) || this.#botId;
    if (channel !== this.#channel || botId !== this.#botId) return null;
    const chatId = cleanOneLine(raw.chatId, 200);
    if (!chatId) return null;
    const existing = this.#groups.get(chatId) ?? null;
    const groupName = cleanOneLine(raw.groupName, MAX_GROUP_NAME) || existing?.groupName || '';
    const rawMemberCount = Number.isInteger(raw.memberCount) && raw.memberCount > 0
      && raw.memberCount <= MAX_MEMBER_COUNT ? raw.memberCount : null;
    const memberCount = rawMemberCount ?? existing?.memberCount ?? null;
    const lastSeenAt = Math.max(finiteNumber(raw.lastSeenAt, 0), existing?.lastSeenAt ?? 0);
    const lastConsolidatedAt = Math.max(finiteNumber(raw.lastConsolidatedAt, 0), existing?.lastConsolidatedAt ?? 0);
    const record = {
      channel,
      botId,
      chatId,
      groupName,
      memberCount,
      lastSeenAt,
      lastConsolidatedAt,
    };
    const meaningfulChange = !existing
      || existing.groupName !== record.groupName
      || existing.memberCount !== record.memberCount;
    this.#groups.set(chatId, record);
    if (save && meaningfulChange) {
      void this.#saveRegistry();
    }
    return record;
  }

  #updateGroupRecord(chatId, patch) {
    const existing = this.#groups.get(chatId);
    if (!existing) return null;
    const record = { ...existing, ...patch };
    this.#groups.set(chatId, record);
    return record;
  }

  // ---------------------------------------------------------------------------
  // 存储/画像懒加载
  // ---------------------------------------------------------------------------

  async #storeFor(chatId) {
    const cached = this.#stores.get(chatId);
    if (cached) return cached;
    const record = this.#groups.get(chatId);
    const store = this.#storeFactory({
      root: this.#root,
      channel: this.#channel,
      botId: this.#botId,
      chatId,
      groupName: record?.groupName ?? '',
      now: this.#now,
      logger: this.#logger,
    });
    await store.load();
    this.#stores.set(chatId, store);
    return store;
  }

  async #profilesFor(chatId) {
    const cached = this.#profiles.get(chatId);
    if (cached) return cached.list();
    const store = await this.#storeFor(chatId);
    const settings = this.#currentSettings();
    const profiles = this.#profilesFactory({
      store,
      maxProfiles: settings.profiles.maxProfiles,
      now: this.#now,
    });
    await profiles.load().catch((error) => {
      this.#logger.warn?.('[dsh-im] group member profiles load failed:', error);
    });
    this.#profiles.set(chatId, profiles);
    return profiles.list();
  }

  #orderedProfiles(list, senderId = '') {
    const profiles = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!senderId) return profiles;
    return [...profiles].sort((left, right) => {
      if (left.memberId === senderId) return -1;
      if (right.memberId === senderId) return 1;
      return (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0);
    });
  }

  // ---------------------------------------------------------------------------
  // 外部接口：入站观察
  // ---------------------------------------------------------------------------

  /**
   * 记录一条群消息，并返回是否需要向该消息注入群聊上下文。
   *
   * event: {chatId, groupName?, memberCount?, messageId, senderId, senderName?,
   *         text?, mentionedBot, at?, kind?}
   *
   * 返回值：{direct, recorded, duplicate, blocks}
   * - direct=true 表示这条消息明确 @ 了机器人，blocks 应拼进用户消息；
   * - 未 @ 消息返回 blocks=[]，只记录并参与话题停顿判断。
   */
  async observe(event) {
    const normalized = this.#normalizeEvent(event);
    if (!normalized) return { direct: false, recorded: false, duplicate: false, blocks: [] };
    const settings = this.#currentSettings();
    if (settings.enabled !== true) {
      return { direct: false, recorded: false, duplicate: false, blocks: [] };
    }
    const record = this.#upsertGroupRecord({
      channel: this.#channel,
      botId: this.#botId,
      chatId: normalized.chatId,
      groupName: normalized.groupName,
      memberCount: normalized.memberCount,
      lastSeenAt: normalized.at,
    });
    if (!record) return { direct: false, recorded: false, duplicate: false, blocks: [] };
    const store = await this.#storeFor(normalized.chatId);
    let duplicate = false;
    try {
      const result = await store.recordMessage({
        messageId: normalized.messageId,
        senderId: normalized.senderId,
        senderName: normalized.senderName,
        text: normalized.text,
        mentionedBot: normalized.mentionedBot,
        at: normalized.at,
        kind: normalized.kind,
      });
      duplicate = result?.duplicate === true;
    } catch (error) {
      this.#logger.warn?.('[dsh-im] group brain message record failed:', error);
    }
    // 同一条消息被重复投递（例如重连回放或多个桥接实例）时，不重复触发
    // 自动接话/连续对话，否则会白白消耗接话额度并污染会话。
    if (duplicate) {
      return { direct: false, followUp: false, recorded: false, duplicate: true, blocks: [] };
    }
    let outcome = 'record';
    try {
      outcome = this.#trigger?.observe({
        chatId: normalized.chatId,
        mentionedBot: normalized.mentionedBot,
        at: normalized.at,
      }) ?? 'record';
    } catch (error) {
      this.#logger.warn?.('[dsh-im] group trigger observe failed:', error);
    }
    if (outcome === 'followUp') {
      // 被 @ 之后的连续对话窗口：群成员继续聊天时直接自然接话。
      // 与自动接话共用同一套安全门槛（白名单或已知小群）。
      if (!this.#ambientAllowed(settings, record)) {
        return { direct: false, followUp: false, recorded: true, duplicate, blocks: [] };
      }
      return { direct: false, followUp: true, recorded: true, duplicate, blocks: [] };
    }
    if (outcome !== 'direct') {
      return { direct: false, recorded: true, duplicate, blocks: [] };
    }
    const blocks = [buildDirectInstructionBlock({ senderName: normalized.senderName })];
    try {
      const memory = await store.getMemory();
      const profileList = settings.profiles.enabled === true
        ? this.#orderedProfiles(await this.#profilesFor(normalized.chatId), normalized.senderId)
        : [];
      if (memory || profileList.length) {
        blocks.push(buildGroupMemoryBlock({
          memory,
          profiles: profileList,
          maxChars: DIRECT_MEMORY_MAX_CHARS,
        }));
      }
    } catch (error) {
      this.#logger.warn?.('[dsh-im] group brain memory injection failed:', error);
    }
    return { direct: true, recorded: true, duplicate, blocks };
  }

  #normalizeEvent(event) {
    if (!isPlainRecord(event)) return null;
    const chatId = cleanOneLine(event.chatId, 200);
    if (!chatId) return null;
    const senderId = cleanOneLine(event.senderId, 200) || 'unknown';
    const senderName = cleanOneLine(event.senderName, 60) || senderId;
    const text = cleanText(event.text, MAX_MESSAGE_TEXT);
    const kind = cleanOneLine(event.kind, 32) || 'group';
    const at = finiteNumber(event.at, this.#now());
    const messageId = cleanOneLine(event.messageId, 200) || `${at}-${randomUUID()}`;
    const mentionedBot = event.mentionedBot === true;
    const groupName = cleanOneLine(event.groupName, MAX_GROUP_NAME);
    const memberCount = Number.isInteger(event.memberCount) && event.memberCount > 0
      && event.memberCount <= MAX_MEMBER_COUNT ? event.memberCount : null;
    return {
      chatId,
      senderId,
      senderName,
      text,
      kind,
      at,
      messageId,
      mentionedBot,
      groupName,
      memberCount,
    };
  }

  // ---------------------------------------------------------------------------
  // 自动接话
  // ---------------------------------------------------------------------------

  #ambientAllowed(settings, record) {
    if (settings.ambient?.enabled !== true) return false;
    if (typeof this.#send !== 'function') return false;
    if (isGroupAllowed(settings, {
      channel: this.#channel,
      botId: this.#botId,
      chatId: record.chatId,
    })) return true;
    return Number.isInteger(record.memberCount)
      && record.memberCount > 0
      && record.memberCount <= settings.maxMembers;
  }

  async #handleAmbient(chatId, info = {}) {
    const settings = this.#currentSettings();
    if (settings.enabled !== true || settings.ambient.enabled !== true) return;
    const record = this.#groups.get(chatId);
    if (!record || !this.#ambientAllowed(settings, record)) return;
    await this.#serialize(chatId, async () => {
      const store = await this.#storeFor(chatId);
      const fromAt = finiteNumber(info.fromAt, 0);
      const messages = [];
      try {
        for await (const message of store.messagesSince(fromAt, { limitMessages: AMBIENT_PROMPT_MESSAGE_LIMIT })) {
          messages.push(message);
        }
      } catch (error) {
        this.#logger.warn?.('[dsh-im] group ambient history read failed:', error);
        return;
      }
      const segment = messages
        .filter((message) => message?.kind !== 'bot' && typeof message?.text === 'string' && message.text)
        .slice(-AMBIENT_SEGMENT_LIMIT);
      if (segment.length < settings.ambient.minMessages) return;

      // 同一群已经用同一个 DSH 会话聊过时，完整人设/记忆/画像已在该会话历史里，
      // 这里只补充最近消息，避免每轮重复注入大块内容浪费 token。
      const reused = await this.#isSessionReused(chatId);
      const memory = reused ? '' : await store.getMemory().catch(() => '');
      const profileList = !reused && settings.profiles.enabled === true
        ? this.#orderedProfiles(await this.#profilesFor(chatId)).slice(0, settings.profiles.maxProfiles)
        : [];
      const persona = reused ? '' : await this.#personaText();
      const prompt = buildAmbientPrompt({
        groupName: record.groupName,
        memberCount: record.memberCount,
        segmentMessages: segment,
        memory,
        profiles: profileList,
        persona,
        compact: reused,
        now: this.#now(),
      });

      let raw;
      try {
        raw = await this.#generate({
          kind: 'ambient',
          prompt,
          meta: { channel: this.#channel, botId: this.#botId, chatId, groupName: record.groupName },
        });
      } catch (error) {
        this.#logger.warn?.('[dsh-im] group ambient generation failed:', error);
        return;
      }
      const result = parseAmbientResult(raw);
      const text = result.skip ? '' : cleanText(result.text, MAX_AMBIENT_REPLY_CHARS);
      if (!text) return;
      try {
        await this.#send({
          chatId,
          text,
          groupName: record.groupName,
          meta: { channel: this.#channel, botId: this.#botId, reason: 'ambient' },
        });
      } catch (error) {
        this.#logger.warn?.('[dsh-im] group ambient send failed:', error);
        return;
      }
      try {
        await store.recordMessage({
          messageId: `bot-${randomUUID()}`,
          senderId: 'bot',
          senderName: persona ? (await this.#personaName()) : '机器人',
          text,
          kind: 'bot',
          at: this.#now(),
        });
      } catch (error) {
        this.#logger.warn?.('[dsh-im] group ambient message record failed:', error);
      }
    });
  }

  async #persona() {
    if (!this.#resolvePersona) return null;
    try {
      const persona = await this.#resolvePersona();
      return persona && persona.enabled !== false && typeof persona.text === 'string' ? persona : null;
    } catch (error) {
      this.#logger.warn?.('[dsh-im] group brain persona resolve failed:', error);
      return null;
    }
  }

  async #isSessionReused(chatId) {
    if (!this.#sessionExists) return false;
    try {
      return (await this.#sessionExists(chatId)) === true;
    } catch (error) {
      this.#logger.warn?.('[dsh-im] unable to resolve group session state:', error);
      return false;
    }
  }

  async #personaText() {
    const persona = await this.#persona();
    return persona?.text ?? '';
  }

  async #personaName() {
    const persona = await this.#persona();
    return cleanOneLine(persona?.name, 60) || '机器人';
  }

  // ---------------------------------------------------------------------------
  // 长期记忆压缩
  // ---------------------------------------------------------------------------

  /** 检查所有已知群是否到达压缩间隔；force=true 时无条件压缩。 */
  async maybeConsolidateAll({ force = false } = {}) {
    await this.#loadRegistry();
    const settings = this.#currentSettings();
    const intervalMs = settings.memory.consolidateIntervalDays * 24 * 60 * 60 * 1_000;
    const now = this.#now();
    let consolidated = 0;
    for (const record of [...this.#groups.values()]) {
      const due = force === true || !record.lastConsolidatedAt
        || now - record.lastConsolidatedAt >= intervalMs;
      if (!due) continue;
      try {
        const result = await this.#consolidate(record.chatId);
        if (result) consolidated += 1;
      } catch (error) {
        this.#logger.warn?.(`[dsh-im] group "${record.chatId}" consolidation failed:`, error);
      }
    }
    if (consolidated > 0) await this.#saveRegistry();
    return { consolidated, dueGroups: this.#groups.size };
  }

  /** 立即压缩某个群的长期记忆（设置页“立即整理”用）。 */
  async forceConsolidate(chatId) {
    await this.#loadRegistry();
    const id = cleanOneLine(chatId, 200);
    if (!id || !this.#groups.has(id)) return { ok: false, reason: 'unknown-group' };
    const consolidated = await this.#consolidate(id);
    if (consolidated) await this.#saveRegistry();
    return { ok: true, consolidated };
  }

  async #consolidate(chatId) {
    const settings = this.#currentSettings();
    const record = this.#groups.get(chatId);
    if (!record) return false;
    return this.#serialize(chatId, async () => {
      const store = await this.#storeFor(chatId);
      const since = record.lastConsolidatedAt || 0;
      const collected = [];
      let characters = 0;
      try {
        for await (const message of store.messagesSince(since, { limitMessages: CONSOLIDATION_MESSAGE_LIMIT })) {
          if (message?.kind === 'bot' || typeof message?.text !== 'string' || !message.text) continue;
          characters += message.text.length + 16;
          if (characters > CONSOLIDATION_CHAR_LIMIT) break;
          collected.push(message);
        }
      } catch (error) {
        this.#logger.warn?.('[dsh-im] group consolidation history read failed:', error);
        return false;
      }
      const now = this.#now();
      if (collected.length === 0) {
        this.#updateGroupRecord(chatId, { lastConsolidatedAt: now });
        await store.updateState({ lastConsolidatedAt: now }).catch(() => {});
        return false;
      }
      const segments = splitIntoSegments(collected, settings.memory.segmentGapMs);
      const previousMemory = await store.getMemory().catch(() => '');
      const memberIds = [...new Set(collected.map((message) => message.senderId))].slice(0, 50);
      const prompt = buildConsolidationPrompt({
        groupName: record.groupName,
        memberIds,
        segments,
        previousMemory,
        maxMemoryChars: settings.memory.maxMemoryChars,
        profileLimit: settings.profiles.enabled === true ? settings.profiles.maxProfiles : 0,
      });
      let raw;
      try {
        raw = await this.#generate({
          kind: 'consolidate',
          prompt,
          meta: { channel: this.#channel, botId: this.#botId, chatId, groupName: record.groupName },
        });
      } catch (error) {
        this.#logger.warn?.('[dsh-im] group consolidation generation failed:', error);
        return false;
      }
      let parsed;
      try {
        parsed = parseConsolidationResult(raw);
      } catch (error) {
        this.#logger.warn?.('[dsh-im] group consolidation result invalid:', error);
        return false;
      }
      try {
        await store.saveMemory(parsed.memory, { maxChars: settings.memory.maxMemoryChars });
        if (settings.profiles.enabled === true && parsed.profiles.length > 0) {
          const profiles = await this.#loadProfilesForUpdate(chatId);
          if (profiles) {
            await profiles.upsertMany(parsed.profiles);
            await profiles.pruneTo(settings.profiles.maxProfiles);
          }
        }
        await store.updateState({ lastConsolidatedAt: now });
        this.#updateGroupRecord(chatId, { lastConsolidatedAt: now });
      } catch (error) {
        this.#logger.warn?.('[dsh-im] group consolidation persist failed:', error);
        return false;
      }
      return true;
    });
  }

  async #loadProfilesForUpdate(chatId) {
    const cached = this.#profiles.get(chatId);
    if (cached) return cached;
    const store = await this.#storeFor(chatId);
    const profiles = this.#profilesFactory({
      store,
      maxProfiles: this.#currentSettings().profiles.maxProfiles,
      now: this.#now,
    });
    await profiles.load();
    this.#profiles.set(chatId, profiles);
    return profiles;
  }

  // ---------------------------------------------------------------------------
  // 状态与并发控制
  // ---------------------------------------------------------------------------

  /** 供 Host RPC/设置页读取的概览。 */
  async status() {
    if (!this.#settings) await this.#loadSettings();
    const settings = this.#currentSettings();
    const intervalMs = settings.memory.consolidateIntervalDays * 24 * 60 * 60 * 1_000;
    const now = this.#now();
    return {
      enabled: settings.enabled,
      channel: this.#channel,
      botId: this.#botId,
      settings,
      groups: [...this.#groups.values()].map((record) => ({
        ...record,
        nextConsolidateAt: (record.lastConsolidatedAt || now) + intervalMs,
      })),
    };
  }

  dispose() {
    if (this.#consolidationTimer) {
      this.#timerFns.clearInterval?.(this.#consolidationTimer);
      this.#consolidationTimer = null;
    }
    try {
      this.#trigger?.dispose?.();
    } catch {
      // 忽略清理异常。
    }
    this.#trigger = null;
    this.#started = false;
  }

  #serialize(key, task) {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const guarded = next.finally(() => {
      if (this.#queues.get(key) === guarded) this.#queues.delete(key);
    });
    this.#queues.set(key, guarded);
    return guarded;
  }
}

function splitIntoSegments(messages, gapMs) {
  const segments = [];
  let current = null;
  let lastAt = 0;
  for (const message of messages) {
    const at = finiteNumber(message.at, lastAt);
    if (!current || at - lastAt > gapMs) {
      current = { at, messages: [] };
      segments.push(current);
    }
    current.messages.push(message);
    lastAt = at;
  }
  return segments;
}
