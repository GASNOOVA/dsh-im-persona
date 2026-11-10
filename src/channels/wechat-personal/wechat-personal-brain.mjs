// 微信个人号群聊桥：把 agent-wechat daemon 的 SSE 事件翻译成群聊大脑的 observe 输入。
//
// 设计原则：
// - 群聊大脑（GroupBrain）负责记录、记忆整理、成员画像与自动接话时机；
// - 本桥只做「事件 → observe」与「@ 直通回复 / 自动接话发送」两件事；
// - 只处理文本消息（type 1）；图片/文件/语音等留给后续迭代；
// - 游标持久化到私有 JSON 文件，断线重连从上一个 cursor 续传，避免漏消息或重复处理。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AMBIENT_REPLY_MAX_CHARS, SKIP_TOKEN } from '../shared/group-brain/group-context.mjs';

/** 单条回复的硬上限：微信文本消息远大于此，但刷屏保护仍然有价值。 */
export const WECHAT_PERSONAL_MAX_REPLY_CHARS = 4_000;
/** @ 直通回复时带入的最近聊天条数。 */
export const WECHAT_PERSONAL_TRANSCRIPT_LIMIT = 20;
/** 群名/成员缓存时间：避免每条消息都打 daemon。 */
export const WECHAT_PERSONAL_GROUP_CACHE_MS = 60_000;
/** SSE 断线后的重连等待。 */
export const WECHAT_PERSONAL_RECONNECT_MS = 3_000;

const CURSOR_DOCUMENT_VERSION = 1;

function isGroupThreadId(value) {
  return typeof value === 'string' && value.endsWith('@chatroom');
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatClock(value) {
  const timestamp = Date.parse(value ?? '');
  if (!Number.isFinite(timestamp)) return '--:--';
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * 把一个群消息格式化成转录行。
 * @param {{createdAt?:string,senderId?:string,body?:string}} message
 * @param {(id:string)=>string} nameOf
 */
export function formatTranscriptLine(message, nameOf) {
  const sender = nameOf(message?.senderId ?? '') || textOf(message?.senderId) || '未知成员';
  return `[${formatClock(message?.createdAt)}] ${sender}：${textOf(message?.body)}`;
}

/**
 * 微信个人号 ↔ 群聊大脑桥。
 *
 * 构造后必须先 `start()`；宿主管理器负责传入已经就绪的 GroupBrain 与生成函数。
 */
export class WechatPersonalGroupBridge {
  #client;
  #brain;
  #generate;
  #resolvePersona;
  #accountId;
  #ownUserId;
  #statePath;
  #logger;
  #now;
  #transcriptLimit;
  #abortController = null;
  #loopPromise = null;
  #running = false;
  #cursor = null;
  #lastError = null;
  #startedAt = null;
  #groups = new Map();
  #groupCache = new Map();

  constructor({
    client,
    brain,
    generate,
    resolvePersona = null,
    accountId,
    ownUserId,
    statePath,
    logger = console,
    now = () => Date.now(),
    transcriptLimit = WECHAT_PERSONAL_TRANSCRIPT_LIMIT,
  } = {}) {
    if (!client) throw new TypeError('WechatPersonalGroupBridge requires a client');
    if (!brain) throw new TypeError('WechatPersonalGroupBridge requires a group brain');
    if (typeof generate !== 'function') throw new TypeError('WechatPersonalGroupBridge requires a generate function');
    if (typeof accountId !== 'string' || !accountId) throw new TypeError('WechatPersonalGroupBridge requires an accountId');
    if (typeof ownUserId !== 'string' || !ownUserId) throw new TypeError('WechatPersonalGroupBridge requires ownUserId');
    this.#client = client;
    this.#brain = brain;
    this.#generate = generate;
    this.#resolvePersona = typeof resolvePersona === 'function' ? resolvePersona : null;
    this.#accountId = accountId;
    this.#ownUserId = ownUserId;
    this.#statePath = textOf(statePath) || join(process.cwd(), 'wechat-personal-cursor.json');
    this.#logger = logger ?? console;
    this.#now = now;
    this.#transcriptLimit = Number.isInteger(transcriptLimit) && transcriptLimit > 0 ? transcriptLimit : WECHAT_PERSONAL_TRANSCRIPT_LIMIT;
  }

  get accountId() {
    return this.#accountId;
  }

  get running() {
    return this.#running;
  }

  get cursor() {
    return this.#cursor;
  }

  /** 读取持久化游标；文件缺失或损坏都 fail-soft。 */
  async loadCursor() {
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, 'utf8'));
      if (parsed?.version !== CURSOR_DOCUMENT_VERSION) return null;
      this.#cursor = typeof parsed.cursor === 'string' && parsed.cursor ? parsed.cursor : null;
      return this.#cursor;
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#logger.warn?.('[dsh-im:wechat-personal] unable to load cursor:', error?.message ?? error);
      return null;
    }
  }

  async #saveCursor(cursor) {
    if (typeof cursor !== 'string' || !cursor) return;
    this.#cursor = cursor;
    const document = { version: CURSOR_DOCUMENT_VERSION, cursor, updatedAt: new Date(this.#now()).toISOString() };
    try {
      await mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.#statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#statePath);
    } catch (error) {
      await rm(`${this.#statePath}.${randomUUID()}.tmp`, { force: true }).catch(() => {});
      this.#logger.warn?.('[dsh-im:wechat-personal] unable to save cursor:', error?.message ?? error);
    }
  }

  /** 启动事件循环；重复调用是幂等的。 */
  async start() {
    if (this.#running) return;
    await this.loadCursor();
    // 首次启动（没有游标文件）时从 daemon 当前游标开始，避免回放历史群消息。
    if (!this.#cursor) {
      try {
        const latest = await this.#client.latestEventCursor?.();
        if (typeof latest === 'string' && latest) {
          this.#cursor = latest;
          await this.#saveCursor(latest);
        }
      } catch (error) {
        this.#logger.warn?.('[dsh-im:wechat-personal] unable to resolve starting cursor:', error?.message ?? error);
      }
    }
    this.#running = true;
    this.#lastError = null;
    this.#startedAt = this.#now();
    this.#abortController = new AbortController();
    this.#loopPromise = this.#runLoop(this.#abortController.signal);
    this.#logger.info?.('[dsh-im:wechat-personal] event bridge started', this.#cursor ? `(after ${this.#cursor})` : '(from now)');
  }

  /** 停止事件循环并等待其退出。 */
  async stop() {
    this.#running = false;
    this.#abortController?.abort();
    const promise = this.#loopPromise;
    this.#loopPromise = null;
    this.#abortController = null;
    if (promise) await promise.catch(() => {});
    this.#logger.info?.('[dsh-im:wechat-personal] event bridge stopped');
  }

  /** 供 GroupBrain 的 send 回调使用：发送一条自动接话并记入长期记录。 */
  async sendAmbient({ chatId, text, groupName } = {}) {
    const reply = textOf(text).slice(0, WECHAT_PERSONAL_MAX_REPLY_CHARS);
    if (!isGroupThreadId(chatId) || !reply) return false;
    await this.#client.sendText({ threadId: chatId, text: reply });
    await this.#recordBotMessage({ chatId, text: reply, groupName });
    return true;
  }

  async #recordBotMessage({ chatId, text, groupName }) {
    try {
      await this.#brain.observe({
        chatId,
        groupName: textOf(groupName) || this.#groups.get(chatId)?.name || '',
        messageId: `bot:${randomUUID()}`,
        senderId: this.#ownUserId,
        senderName: this.#groups.get(chatId)?.selfName ?? '',
        text,
        mentionedBot: false,
        at: this.#now(),
        kind: 'bot',
      });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] unable to record bot message:', error?.message ?? error);
    }
  }

  async status() {
    return {
      running: this.#running,
      accountId: this.#accountId,
      ownUserId: this.#ownUserId,
      cursor: this.#cursor,
      startedAt: this.#startedAt,
      lastError: this.#lastError,
      groups: [...this.#groups.values()].map((group) => ({
        chatId: group.chatId,
        name: group.name,
        memberCount: group.memberCount,
        lastSeenAt: group.lastSeenAt,
      })),
    };
  }

  async #runLoop(signal) {
    while (!signal.aborted) {
      try {
        for await (const event of this.#client.streamEvents({ after: this.#cursor, signal })) {
          if (signal.aborted) return;
          await this.#handleEvent(event);
        }
        if (signal.aborted) return;
        // 事件流正常结束（daemon 重启/连接被服务端关闭）：短暂等待后续传。
        await sleep(WECHAT_PERSONAL_RECONNECT_MS, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.#lastError = error?.message ?? String(error);
        this.#logger.warn?.('[dsh-im:wechat-personal] event stream interrupted, reconnecting:', this.#lastError);
        await sleep(WECHAT_PERSONAL_RECONNECT_MS, signal);
      }
    }
  }

  async #handleEvent(event) {
    if (typeof event?.cursor === 'string' && event.cursor) await this.#saveCursor(event.cursor);
    if (event?.kind !== 'message.committed') return;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return;
    if (payload.direction !== 'incoming') return;
    const messageId = textOf(payload.messageId) || textOf(payload.id);
    if (!messageId) return;
    let message;
    try {
      message = await this.#client.getMessage(messageId);
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] unable to fetch message:', error?.message ?? error);
      return;
    }
    if (!message) return;
    if (message.direction && message.direction !== 'incoming') return;
    if (!isGroupThreadId(message.threadId)) return;
    await this.#handleGroupMessage({ ...message, id: textOf(message?.id) || messageId });
  }

  async #handleGroupMessage(message) {
    const chatId = message.threadId;
    const text = textOf(message.body);
    if (!text) return; // 图片/文件等非文本消息暂不进入群脑，避免空文本破坏画像。
    const group = await this.#groupInfo(chatId);
    const addressed = message.mentions?.self === true
      || (Array.isArray(message.mentions?.userIds) && message.mentions.userIds.includes(this.#ownUserId));
    const senderName = group.members.get(message.senderId) ?? textOf(message.senderId);
    const event = {
      chatId,
      groupName: group.name,
      memberCount: group.memberCount,
      messageId: message.id,
      senderId: message.senderId,
      senderName,
      text,
      mentionedBot: addressed,
      at: Number.isFinite(Date.parse(message.createdAt ?? '')) ? Date.parse(message.createdAt) : this.#now(),
      kind: 'group',
    };
    let observed;
    try {
      observed = await this.#brain.observe(event);
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] group brain observe failed:', error?.message ?? error);
      return;
    }
    this.#groups.set(chatId, { ...(this.#groups.get(chatId) ?? {}), chatId, name: group.name, memberCount: group.memberCount, lastSeenAt: event.at });
    if (!observed?.direct) return;
    await this.#replyDirect({ event, observed, message });
  }

  async #replyDirect({ event, observed, message }) {
    try {
      const persona = await this.#persona();
      const transcript = await this.#recentTranscript(event.chatId, message.id, event.groupName);
      const blocks = (observed.blocks ?? []).filter((block) => typeof block === 'string' && block.trim());
      const sections = [];
      if (persona?.text) sections.push(`<dsh_im_persona>\n${persona.text}\n</dsh_im_persona>`);
      if (transcript) sections.push(`群「${event.groupName || event.chatId}」最近聊天：\n${transcript}`);
      sections.push(`群成员 ${event.senderName} 刚刚 @ 你：\n${event.text}`);
      if (blocks.length > 0) sections.push(...blocks);
      sections.push('请用纯文本直接回复（不要使用 Markdown 标记，不要输出解释过程）；回复要像群友聊天，简洁自然。');
      const prompt = sections.join('\n\n');
      const raw = await this.#generate({ kind: 'direct', prompt, meta: { chatId: event.chatId, senderId: event.senderId, channel: 'wechat-personal' } });
      const text = textOf(raw);
      if (!text || text === SKIP_TOKEN || text.startsWith(SKIP_TOKEN)) return;
      const reply = text.slice(0, WECHAT_PERSONAL_MAX_REPLY_CHARS);
      await this.#client.sendText({ threadId: event.chatId, text: reply, mentions: { userIds: [event.senderId] } });
      await this.#recordBotMessage({ chatId: event.chatId, text: reply, groupName: event.groupName });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] direct reply failed:', error?.message ?? error);
    }
  }

  async #persona() {
    if (!this.#resolvePersona) return null;
    try {
      const resolved = await this.#resolvePersona();
      return resolved && typeof resolved === 'object' && typeof resolved.text === 'string' && resolved.text.trim()
        ? { name: textOf(resolved.name), text: resolved.text.trim() }
        : null;
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] unable to resolve persona:', error?.message ?? error);
      return null;
    }
  }

  async #recentTranscript(chatId, currentMessageId, groupName) {
    try {
      const messages = await this.#client.listMessages(chatId, { limit: this.#transcriptLimit + 1 });
      const lines = messages
        .filter((message) => message && message.id !== currentMessageId && textOf(message.body))
        .slice(0, this.#transcriptLimit)
        .reverse()
        .map((message) => formatTranscriptLine(message, (senderId) => this.#groupCache.get(chatId)?.members.get(senderId) ?? textOf(senderId)));
      if (lines.length === 0) return '';
      return lines.join('\n').slice(-6_000);
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] unable to read transcript:', error?.message ?? error);
      return '';
    }
  }

  async #groupInfo(chatId) {
    const cached = this.#groupCache.get(chatId);
    if (cached && this.#now() - cached.at < WECHAT_PERSONAL_GROUP_CACHE_MS) return cached;
    let name = cached?.name ?? '';
    let selfName = cached?.selfName ?? '';
    const members = new Map(cached?.members ?? []);
    let memberCount = cached?.memberCount ?? 0;
    try {
      const threads = await this.#client.listThreads({ limit: 50 });
      const thread = threads.find((item) => item.id === chatId);
      if (thread) {
        name = textOf(thread.displayName) || name;
        for (const avatar of Array.isArray(thread.avatarMembers) ? thread.avatarMembers : []) {
          const id = textOf(avatar?.id);
          if (id) members.set(id, textOf(avatar?.displayName) || members.get(id) || id);
        }
        if (Array.isArray(thread.avatarMembers) && thread.avatarMembers.length > memberCount) memberCount = thread.avatarMembers.length;
      }
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] unable to read threads:', error?.message ?? error);
    }
    try {
      const list = await this.#client.listMembers(chatId, { limit: 100 });
      if (Array.isArray(list) && list.length > 0) {
        memberCount = list.length;
        for (const member of list) {
          const id = textOf(member?.id) || textOf(member?.username);
          if (!id) continue;
          const displayName = textOf(member?.displayName) || textOf(member?.mentionName) || id;
          members.set(id, displayName);
          if (id === this.#ownUserId) selfName = displayName;
        }
      }
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] unable to read group members:', error?.message ?? error);
    }
    const info = { at: this.#now(), name, selfName, memberCount, members };
    this.#groupCache.set(chatId, info);
    return info;
  }
}

/**
 * 创建桥的便捷函数；宿主可先建 brain，再用返回的实例作为 send 目标。
 */
export function createWechatPersonalGroupBridge(options) {
  return new WechatPersonalGroupBridge(options);
}

export { AMBIENT_REPLY_MAX_CHARS };
