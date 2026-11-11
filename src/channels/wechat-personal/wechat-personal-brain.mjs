// 微信个人号群聊桥：把 agent-wechat daemon 的 SSE 事件翻译成群聊大脑的 observe 输入。
//
// 设计原则：
// - 群聊大脑（GroupBrain）负责记录、记忆整理、成员画像与自动接话时机；
// - 本桥只做「事件 → observe」与「@ 直通回复 / 自动接话发送」两件事；
// - 文本消息进入群脑；图片消息会先经 daemon 下载附件，作为图片输入交给模型；
// - 游标持久化到私有 JSON 文件，断线重连从上一个 cursor 续传，避免漏消息或重复处理。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AMBIENT_REPLY_MAX_CHARS, SKIP_TOKEN } from '../shared/group-brain/group-context.mjs';
import { OFF_PEAK_SLEEP_REPLY_MIN_INTERVAL_MS, offPeakSleepReplyText } from '../shared/off-peak.mjs';
import { findBilibiliUrl, coverAckText, parseCoverCommand } from './cover-command.mjs';

/** 单条回复的硬上限：微信文本消息远大于此，但刷屏保护仍然有价值。 */
export const WECHAT_PERSONAL_MAX_REPLY_CHARS = 4_000;
/** @ 直通回复时带入的最近聊天条数。 */
export const WECHAT_PERSONAL_TRANSCRIPT_LIMIT = 20;
/** 同一群已复用 DSH 会话时，只补最近几条消息，避免重复注入历史。 */
export const WECHAT_PERSONAL_COMPACT_TRANSCRIPT_LIMIT = 8;
/** 连续对话（follow-up）复用会话时补充的最近消息条数。 */
export const WECHAT_PERSONAL_COMPACT_FOLLOW_UP_LIMIT = 6;

/** 每个群最多缓存的待回复任务数（含续聊与 @ 直连）。 */
export const WECHAT_PERSONAL_REPLY_QUEUE_LIMIT = 100;

/** 续聊回复前的默认合并窗口：同一成员连续发言时合并成一次回复。 */
export const WECHAT_PERSONAL_REPLY_MERGE_WINDOW_MS = 30_000;
/** 「普通消息一律语音」模式下，每条语音条的最大字数。 */
export const WECHAT_PERSONAL_VOICE_CHUNK_CHARS = 180;
/** 「普通消息一律语音」模式下，一条回复最多拆成几段语音，防止刷屏。 */
export const WECHAT_PERSONAL_VOICE_MAX_CHUNKS = 4;
/** 群名/成员缓存时间：避免每条消息都打 daemon。 */
export const WECHAT_PERSONAL_GROUP_CACHE_MS = 60_000;
/** SSE 断线后的重连等待。 */
export const WECHAT_PERSONAL_RECONNECT_MS = 3_000;
/** 翻唱指令允许回溯的「最近 B 站链接」时间窗口（用户先发链接、再说翻唱）。 */
export const WECHAT_PERSONAL_COVER_LINK_MEMORY_MS = 10 * 60_000;

const CURSOR_DOCUMENT_VERSION = 1;

/** 被引用消息里可用于解析的文本：链接卡片/文本消息/图片说明等。 */
function quotedTextOf(quoted) {
  if (!quoted || typeof quoted !== 'object') return '';
  const candidates = [
    quoted.embeddedText,
    quoted.embeddedLink?.url,
    quoted.embeddedLink?.title,
    quoted.body,
    quoted.text,
  ];
  return candidates
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
}

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
function compareEventCursors(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  if (left === right) return 0;
  return String(left) > String(right) ? 1 : -1;
}

export function formatTranscriptLine(message, nameOf) {
  const sender = nameOf(message?.senderId ?? '') || textOf(message?.senderId) || '未知成员';
  return `[${formatClock(message?.createdAt)}] ${sender}：${textOf(message?.body)}`;
}

/**
 * 解析模型回复中的语音标签 `<dsh_im_voice>朗读文字</dsh_im_voice>`。
 * 返回 `{ text, voiceText }`：text 为标签外的普通文本，voiceText 为要合成语音的文字。
 */
export function extractVoiceTag(text) {
  const raw = textOf(text);
  const match = raw.match(/<dsh_im_voice>([\s\S]*?)<\/dsh_im_voice>/i);
  if (!match) return { text: raw, voiceText: '' };
  const voiceText = textOf(match[1]);
  const rest = textOf(raw.replace(match[0], ''));
  return { text: rest, voiceText };
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
  #sessionExists = null;
  #isSleeping = null;
  #voice = null;
  #voiceMode = 'tag';
  #cover = null;
  #coverJobs = new Set();
  #recentBilibiliUrls = new Map();
  #sleepReplyAt = new Map();
  #accountId;
  #ownUserId;
  #statePath;
  #logger;
  #now;
  #transcriptLimit;
  #mergeWindowMs;
  #abortController = null;
  #loopPromise = null;
  #running = false;
  #cursor = null;
  #lastError = null;
  #startedAt = null;
  #groups = new Map();
  #groupCache = new Map();
  #replyQueues = new Map();
  #lastProcessedCursor = null;

  constructor({
    client,
    brain,
    generate,
    resolvePersona = null,
    sessionExists = null,
    isSleeping = null,
    voice = null,
    cover = null,
    accountId,
    ownUserId,
    statePath,
    logger = console,
    now = () => Date.now(),
    transcriptLimit = WECHAT_PERSONAL_TRANSCRIPT_LIMIT,
    mergeWindowMs = WECHAT_PERSONAL_REPLY_MERGE_WINDOW_MS,
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
    this.#sessionExists = typeof sessionExists === 'function' ? sessionExists : null;
    this.#isSleeping = typeof isSleeping === 'function' ? isSleeping : null;
    this.#voice = voice && typeof voice.synthesize === 'function' ? voice : null;
    this.#voiceMode = voice?.mode === 'always' ? 'always' : 'tag';
    this.#cover = cover && cover.client && typeof cover.client.fetchCover === 'function' ? cover : null;
    this.#accountId = accountId;
    this.#ownUserId = ownUserId;
    this.#statePath = textOf(statePath) || join(process.cwd(), 'wechat-personal-cursor.json');
    this.#logger = logger ?? console;
    this.#now = now;
    this.#transcriptLimit = Number.isInteger(transcriptLimit) && transcriptLimit > 0 ? transcriptLimit : WECHAT_PERSONAL_TRANSCRIPT_LIMIT;
    this.#mergeWindowMs = Number.isInteger(mergeWindowMs) && mergeWindowMs >= 0
      ? mergeWindowMs
      : WECHAT_PERSONAL_REPLY_MERGE_WINDOW_MS;
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
    await this.#preloadGroups();
    this.#loopPromise = this.#runLoop(this.#abortController.signal);
    this.#logger.info?.('[dsh-im:wechat-personal] event bridge started', this.#cursor ? `(after ${this.#cursor})` : '(from now)');
  }

  /** 停止事件循环并等待其退出。 */
  async stop() {
    this.#running = false;
    for (const queue of this.#replyQueues.values()) {
      for (const timer of queue.timers.values()) clearTimeout(timer);
      queue.timers.clear();
    }
    for (const controller of this.#coverJobs) controller.abort();
    this.#coverJobs.clear();
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
    // 面板里的「N 个群」来自桥接已知群缓存；刚启动时先按 daemon 的会话列表预热一次，
    // 避免重启后在收到新消息之前一直显示 0 个群。
    if (this.#running && this.#groups.size === 0) {
      await this.#preloadGroups().catch(() => {});
    }
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
      voiceMode: this.#voiceMode,
      coverEnabled: Boolean(this.#cover),
      pendingCovers: this.#coverJobs.size,
      pendingReplies: [...this.#replyQueues.entries()]
        .filter(([, queue]) => queue.jobs.length > 0)
        .map(([chatId, queue]) => ({ chatId, count: queue.jobs.length })),
    };
  }

  /** 从 daemon 的会话列表预热已知群，让状态面板在重启后立即显示群数量。 */
  async #preloadGroups() {
    if (typeof this.#client.listThreads !== 'function') return;
    let threads;
    try {
      threads = await this.#client.listThreads({ limit: 50 });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] unable to preload groups:', error?.message ?? error);
      return;
    }
    const now = this.#now();
    for (const thread of Array.isArray(threads) ? threads : []) {
      const chatId = textOf(thread?.id);
      if (!isGroupThreadId(chatId)) continue;
      const avatarMembers = Array.isArray(thread.avatarMembers) ? thread.avatarMembers : [];
      const previous = this.#groups.get(chatId) ?? {};
      this.#groups.set(chatId, {
        chatId,
        name: textOf(thread.displayName) || previous.name || chatId,
        memberCount: avatarMembers.length || previous.memberCount || 0,
        lastSeenAt: previous.lastSeenAt ?? now,
      });
    }
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
    const cursor = textOf(event?.cursor);
    // 同一条事件在一次运行内被重复投递（重连回放）时跳过，避免重复回复。
    if (cursor && this.#lastProcessedCursor && compareEventCursors(cursor, this.#lastProcessedCursor) <= 0) return;
    if (cursor) {
      await this.#saveCursor(cursor);
      this.#lastProcessedCursor = cursor;
    }
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
    // TODO(识图暂停)：图片识图能力暂时下线，保留 agent-wechat 的媒体客户端代码待后续恢复。
    // 原逻辑：正文为空且 type === 3 时，经 daemon 下载图片附件并作为 images 交给模型。
    if (!text) return; // 图片/文件/语音等非文本消息暂不进入群脑。
    const group = await this.#groupInfo(chatId);
    const addressed = message.mentions?.self === true
      || (Array.isArray(message.mentions?.userIds) && message.mentions.userIds.includes(this.#ownUserId));
    // 群成员回复机器人主动发言（含自动接话/主动发言）时，按一次「类 @」处理：
    // 打开同一个连续对话窗口，并直接回复这条消息；没人回复就自然回到静默。
    const quoted = message.quote ?? null;
    const quotedText = quotedTextOf(quoted);
    const repliedToBot = quoted?.direction === 'outgoing' && quoted?.senderId === this.#ownUserId;
    const senderName = group.members.get(message.senderId) ?? textOf(message.senderId);
    const messageAt = Number.isFinite(Date.parse(message.createdAt ?? '')) ? Date.parse(message.createdAt) : this.#now();
    const event = {
      chatId,
      groupName: group.name,
      memberCount: group.memberCount,
      messageId: message.id,
      senderId: message.senderId,
      senderName,
      text,
      mentionedBot: addressed || repliedToBot,
      repliedToBot,
      quoted: Boolean(quoted),
      at: messageAt,
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
    if (await this.#isSleepingNow()) {
      if (observed?.direct) await this.#sendSleepReply({ event, group });
      return;
    }
    // 记录本群最近出现的 B 站链接：用户习惯先发/引用链接，再单独说「翻唱」。
    const urlInMessage = findBilibiliUrl(text) || findBilibiliUrl(quotedText);
    if (urlInMessage) {
      this.#recentBilibiliUrls.set(chatId, { url: urlInMessage, at: event.at });
    }

    // 翻唱指令：文本带「翻唱」关键词，链接可来自正文、引用消息或最近 10 分钟内的群链接。
    // 命中后不进入普通回复流程：先回一条确认，再异步生成翻唱文件（长任务）。
    let coverCommand = null;
    if (this.#cover) {
      const remembered = this.#recentBilibiliUrls.get(chatId);
      const fallbackUrl = remembered && event.at - remembered.at <= WECHAT_PERSONAL_COVER_LINK_MEMORY_MS
        ? remembered.url
        : '';
      coverCommand = parseCoverCommand(text, {
        maxPromptChars: this.#cover.maxPromptChars,
        quotedText,
        fallbackUrl,
      });
    }
    if (coverCommand) {
      this.#recentBilibiliUrls.delete(chatId);
      await this.#startCoverJob({ event, coverCommand });
      return;
    }
    // 同一个群的所有回复进入 FIFO 队列：多个群成员同时说话时依次回复，
    // 不会因为一次生成耗时较久就丢掉后面的消息；同一成员的连续消息会合并成一次回复。
    if (observed?.direct) {
      this.#enqueueReply(chatId, { kind: 'direct', event, observed, message });
      return;
    }
    if (observed?.followUp) {
      this.#enqueueReply(chatId, { kind: 'follow-up', event, message });
    }
  }

  #replyQueueFor(chatId) {
    let queue = this.#replyQueues.get(chatId);
    if (!queue) {
      queue = { jobs: [], worker: null, timers: new Map() };
      this.#replyQueues.set(chatId, queue);
    }
    return queue;
  }

  #senderKeyOf(job) {
    return textOf(job?.event?.senderId) || 'unknown';
  }

  #clearSenderTimer(queue, senderKey) {
    const timer = queue.timers.get(senderKey);
    if (timer) { clearTimeout(timer); queue.timers.delete(senderKey); }
  }

  #scheduleSenderTimer(chatId, queue, senderKey) {
    if (this.#mergeWindowMs <= 0) {
      this.#clearSenderTimer(queue, senderKey);
      return;
    }
    this.#clearSenderTimer(queue, senderKey);
    const timer = setTimeout(() => {
      queue.timers.delete(senderKey);
      void this.#drainReplyQueue(chatId);
    }, this.#mergeWindowMs);
    timer.unref?.();
    queue.timers.set(senderKey, timer);
  }

  #enqueueReply(chatId, job) {
    const queue = this.#replyQueueFor(chatId);
    const senderKey = this.#senderKeyOf(job);
    if (job.kind === 'direct') {
      // @ 直连优先：立即回复，并清掉同一成员尚未发出的续聊（其内容已在会话记录里）。
      for (let index = queue.jobs.length - 1; index >= 0; index -= 1) {
        const entry = queue.jobs[index];
        if (entry.kind === 'follow-up' && this.#senderKeyOf(entry) === senderKey) queue.jobs.splice(index, 1);
      }
      this.#clearSenderTimer(queue, senderKey);
      queue.jobs.unshift(job);
      void this.#drainReplyQueue(chatId);
      return;
    }
    const sameSender = queue.jobs.find((entry) => entry.kind === 'follow-up' && this.#senderKeyOf(entry) === senderKey);
    if (sameSender) {
      sameSender.event = {
        ...job.event,
        text: `${sameSender.event.text}\n${job.event.text}`,
      };
      sameSender.message = job.message;
      sameSender.merged = (sameSender.merged ?? 1) + 1;
    } else {
      if (queue.jobs.length >= WECHAT_PERSONAL_REPLY_QUEUE_LIMIT) {
        const index = queue.jobs.findIndex((entry) => entry.kind === 'follow-up');
        if (index < 0) {
          this.#logger.warn?.('[dsh-im:wechat-personal] reply queue is full, dropping the message');
          return;
        }
        queue.jobs.splice(index, 1);
        this.#logger.warn?.('[dsh-im:wechat-personal] reply queue is full, dropping an older follow-up');
      }
      queue.jobs.push(job);
    }
    // 同一成员在合并窗口内继续发言时重置计时；窗口结束后统一回复一次。
    this.#scheduleSenderTimer(chatId, queue, senderKey);
    void this.#drainReplyQueue(chatId);
  }

  #drainReplyQueue(chatId) {
    const queue = this.#replyQueueFor(chatId);
    if (queue.worker) return queue.worker;
    const worker = (async () => {
      for (;;) {
        const index = queue.jobs.findIndex((job) => job.kind === 'direct' || !queue.timers.has(this.#senderKeyOf(job)));
        if (index < 0) break;
        const [job] = queue.jobs.splice(index, 1);
        try {
          if (job.kind === 'direct') await this.#replyDirect(job);
          else await this.#replyFollowUp({ event: job.event, message: job.message });
        } catch (error) {
          this.#logger.warn?.(`[dsh-im:wechat-personal] ${job.kind} reply failed:`, error?.message ?? error);
        }
      }
    })();
    queue.worker = worker;
    // worker 一启动就可能同步结束（队列里暂时没有就绪任务），必须在 promise 赋值后再清空，
    // 否则会让 queue.worker 永久保持为已完成的 Promise，后续 drain 全部被短路。
    worker.catch(() => {}).finally(() => {
      if (queue.worker === worker) queue.worker = null;
    });
    return worker;
  }

  async #isSleepingNow() {
    if (!this.#isSleeping) return false;
    try { return (await this.#isSleeping()) === true; } catch { return false; }
  }

  /** 闲时高峰期内被 @ 时回一条固定提示，不调用模型；同一群 5 分钟最多一次。 */
  async #sendSleepReply({ event }) {
    const now = this.#now();
    const last = this.#sleepReplyAt.get(event.chatId) ?? 0;
    if (now - last < OFF_PEAK_SLEEP_REPLY_MIN_INTERVAL_MS) return;
    this.#sleepReplyAt.set(event.chatId, now);
    try {
      const text = offPeakSleepReplyText();
      await this.#client.sendText({
        threadId: event.chatId,
        text,
        mentions: { userIds: [event.senderId] },
      });
      await this.#recordBotMessage({ chatId: event.chatId, text, groupName: event.groupName });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] off-peak sleep reply failed:', error?.message ?? error);
    }
  }

  /** 语音能力是否启用。 */
  get voiceEnabled() {
    return Boolean(this.#voice);
  }

  /** 语音回复模式：tag=标签触发；always=普通回复一律语音条。 */
  get voiceMode() {
    return this.#voiceMode;
  }

  /** B 站翻唱能力是否启用。 */
  get coverEnabled() {
    return Boolean(this.#cover);
  }

  #voiceInstruction() {
    if (!this.#voice || this.#voiceMode === 'always') return '';
    const max = Number.isInteger(this.#voice.maxChars) ? this.#voice.maxChars : 300;
    return `语音：群里可以接收语音。只有当你主动想用语音，或群成员明确要求「用语音/朗读/唱一句/发语音」时，才把要说的话（纯文本、不超过 ${max} 字、不要 Markdown）放进 <dsh_im_voice>…</dsh_im_voice> 标签；标签外文字会作为普通文字消息。不要滥用语音。`;
  }

  /** 把一段回复拆成若干段语音文本（按句读切分，单段不超过 maxChars）。 */
  #splitVoiceChunks(text) {
    const maxChars = Math.max(20, Math.min(
      WECHAT_PERSONAL_VOICE_CHUNK_CHARS,
      Number.isInteger(this.#voice?.maxChars) ? this.#voice.maxChars : WECHAT_PERSONAL_VOICE_CHUNK_CHARS,
    ));
    const clean = textOf(text).replace(/<[^>]+>/g, ' ');
    if (!clean) return [];
    const sentences = clean.match(/[^。！？!?；;，,\n]+[。！？!?；;，,\n]*/g) ?? [clean];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
      const piece = sentence.trim();
      if (!piece) continue;
      if (current && (current + piece).length > maxChars) {
        chunks.push(current);
        current = '';
      }
      if (piece.length > maxChars) {
        if (current) { chunks.push(current); current = ''; }
        for (let index = 0; index < piece.length; index += maxChars) chunks.push(piece.slice(index, index + maxChars));
      } else {
        current += piece;
      }
      if (chunks.length >= WECHAT_PERSONAL_VOICE_MAX_CHUNKS) break;
    }
    if (current) chunks.push(current);
    return chunks.slice(0, WECHAT_PERSONAL_VOICE_MAX_CHUNKS);
  }

  /**
   * 「普通消息一律语音」：把整段回复合成为一条或多条微信语音。
   * 返回 { sent, remaining }；failed 时 remaining 为尚未合成的文本，由调用方回退成文字。
   */
  async #sendVoiceReply({ chatId, text, groupName }) {
    const clean = textOf(text);
    if (!this.#voice || !clean) return { sent: false, remaining: clean };
    const chunks = this.#splitVoiceChunks(clean);
    if (chunks.length === 0) return { sent: false, remaining: clean };
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      try {
        const bytes = await this.#voice.synthesize(chunk);
        const upload = await this.#client.uploadMedia({ name: 'dafeiyu-voice.wav', bytes, mediaType: 'audio/wav' });
        const sourceId = typeof upload?.id === 'string' ? upload.id : '';
        if (!sourceId) throw new Error('media upload did not return an id');
        await this.#client.sendVoice({ threadId: chatId, sourceId });
        await this.#recordBotMessage({ chatId, text: `[语音] ${chunk}`, groupName });
      } catch (error) {
        this.#logger.warn?.('[dsh-im:wechat-personal] all-voice reply failed:', error?.message ?? error);
        return { sent: index > 0, remaining: chunks.slice(index).join('') };
      }
    }
    return { sent: true, remaining: '' };
  }

  /** 翻唱指令：先回确认，再异步生成文件；失败回一条文字说明。 */
  async #startCoverJob({ event, coverCommand }) {
    const ack = coverAckText({ mix: coverCommand.mix });
    try {
      await this.#client.sendText({
        threadId: event.chatId,
        text: ack,
        ...(event.mentionedBot ? { mentions: { userIds: [event.senderId] } } : {}),
      });
      await this.#recordBotMessage({ chatId: event.chatId, text: ack, groupName: event.groupName });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] cover ack failed:', error?.message ?? error);
    }
    const controller = new AbortController();
    this.#coverJobs.add(controller);
    void (async () => {
      try {
        const result = await this.#cover.client.fetchCover({
          url: coverCommand.url,
          mix: coverCommand.mix,
          prompt: coverCommand.prompt,
          signal: controller.signal,
        });
        await this.#sendCoverResult({ event, result });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = `翻唱失败：${String(error?.message ?? error).slice(0, 300)}`;
        this.#logger.warn?.('[dsh-im:wechat-personal] cover job failed:', error?.message ?? error);
        try {
          await this.#client.sendText({ threadId: event.chatId, text: message });
          await this.#recordBotMessage({ chatId: event.chatId, text: message, groupName: event.groupName });
        } catch (sendError) {
          this.#logger.warn?.('[dsh-im:wechat-personal] unable to report cover failure:', sendError?.message ?? sendError);
        }
      } finally {
        this.#coverJobs.delete(controller);
      }
    })();
  }

  /** 翻唱文件回传：上传 MP3 后以文件发送。 */
  async #sendCoverResult({ event, result }) {
    const title = textOf(result?.title) || textOf(result?.bvid) || 'B 站视频';
    const baseName = textOf(result?.title) || textOf(result?.bvid) || 'cover';
    const safeName = baseName.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'cover';
    const format = result?.format === 'wav' ? 'wav' : 'mp3';
    const upload = await this.#client.uploadMedia({
      name: `${safeName}.${format}`,
      bytes: result.bytes,
      mediaType: format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    });
    const sourceId = typeof upload?.id === 'string' ? upload.id : '';
    if (!sourceId) throw new Error('翻唱文件上传未返回 id');
    await this.#client.sendFile({ threadId: event.chatId, sourceId });
    const label = result?.mix === true ? '混音版' : '纯人声版';
    const seconds = Number.isFinite(result?.durationSeconds) ? `，约 ${Math.round(result.durationSeconds)} 秒` : '';
    const caption = `翻唱完成：${title}（${label}${seconds}）`;
    await this.#client.sendText({ threadId: event.chatId, text: caption });
    await this.#recordBotMessage({ chatId: event.chatId, text: `[翻唱] ${title}（${label}）`, groupName: event.groupName });
  }

  async #sendVoiceNote({ chatId, text, groupName }) {
    if (!this.#voice) return false;
    const clean = textOf(text).slice(0, Number.isInteger(this.#voice.maxChars) ? this.#voice.maxChars : 300);
    if (!clean) return false;
    try {
      const bytes = await this.#voice.synthesize(clean);
      const upload = await this.#client.uploadMedia({ name: 'dafeiyu-voice.wav', bytes, mediaType: 'audio/wav' });
      const sourceId = typeof upload?.id === 'string' ? upload.id : '';
      if (!sourceId) throw new Error('media upload did not return an id');
      await this.#client.sendVoice({ threadId: chatId, sourceId });
      await this.#recordBotMessage({ chatId, text: `[语音] ${clean}`, groupName });
      return true;
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] voice reply failed:', error?.message ?? error);
      return false;
    }
  }

  async #replyDirect({ event, observed, message }) {
    try {
      // 同一个群复用统一 DSH 会话：第一次完整注入人设/记忆/画像，之后只补新消息。
      const reused = await this.#isSessionReused(event.chatId);
      const persona = reused ? null : await this.#persona();
      const transcript = await this.#recentTranscript(
        event.chatId,
        message.id,
        event.groupName,
        reused ? WECHAT_PERSONAL_COMPACT_TRANSCRIPT_LIMIT : this.#transcriptLimit,
      );
      const blocks = (observed.blocks ?? [])
        .filter((block) => typeof block === 'string' && block.trim())
        .filter((block) => !reused || !block.includes('<dsh_im_group_memory>'));
      const sections = [];
      if (persona?.text) sections.push(`<dsh_im_persona>\n${persona.text}\n</dsh_im_persona>`);
      if (transcript) sections.push(`群「${event.groupName || event.chatId}」最近聊天：\n${transcript}`);
      const reason = event.repliedToBot ? '刚刚回复了你的消息' : '刚刚 @ 你';
      sections.push(`群成员 ${event.senderName} ${reason}：\n${event.text}`);
      // TODO(识图暂停)：恢复识图时，在 prompt 中加入「对方还发送了一张图片…」并把 images 传给 generate。
      if (blocks.length > 0) sections.push(...blocks);
      const voiceHint = this.#voiceInstruction();
      if (voiceHint) sections.push(voiceHint);
      if (this.#voice && this.#voiceMode === 'always') {
        sections.push('请直接输出回复正文（纯文本、不要 Markdown 标记、不要输出解释过程）；系统会自动把这段回复转成微信语音条。像群友聊天一样简洁自然。');
      } else if (this.#voice) {
        sections.push('请直接回复：普通文字直接输出；如果要发语音，把朗读文字放进 <dsh_im_voice> 标签。不要使用 Markdown 标记，不要输出解释过程，像群友聊天一样简洁自然。');
      } else {
        sections.push('请用纯文本直接回复（不要使用 Markdown 标记，不要输出解释过程）；回复要像群友聊天，简洁自然。');
      }
      const prompt = sections.join('\n\n');
      const raw = await this.#generate({
        kind: 'direct',
        prompt,
        meta: { chatId: event.chatId, senderId: event.senderId, channel: 'wechat-personal' },
      });
      const text = textOf(raw);
      if (!text || text === SKIP_TOKEN || text.startsWith(SKIP_TOKEN)) return;
      if (this.#voice && this.#voiceMode === 'always') {
        const spoken = await this.#sendVoiceReply({ chatId: event.chatId, text, groupName: event.groupName });
        const leftover = textOf(spoken.remaining).slice(0, WECHAT_PERSONAL_MAX_REPLY_CHARS);
        if (spoken.sent && !leftover) return;
        if (leftover) {
          await this.#client.sendText({ threadId: event.chatId, text: leftover, mentions: { userIds: [event.senderId] } });
          await this.#recordBotMessage({ chatId: event.chatId, text: leftover, groupName: event.groupName });
          return;
        }
      }
      const parsed = extractVoiceTag(text);
      let voiceSent = false;
      if (parsed.voiceText) {
        voiceSent = await this.#sendVoiceNote({ chatId: event.chatId, text: parsed.voiceText, groupName: event.groupName });
        if (!voiceSent) parsed.text = textOf(parsed.text) ? `${parsed.text}\n${parsed.voiceText}` : parsed.voiceText;
      }
      const reply = textOf(parsed.text).slice(0, WECHAT_PERSONAL_MAX_REPLY_CHARS);
      if (!reply) {
        if (voiceSent) return;
        return;
      }
      await this.#client.sendText({ threadId: event.chatId, text: reply, mentions: { userIds: [event.senderId] } });
      await this.#recordBotMessage({ chatId: event.chatId, text: reply, groupName: event.groupName });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] direct reply failed:', error?.message ?? error);
    }
  }

  /** 被 @ 后的连续对话窗口：未 @ 的群消息也自然接一句，延续聊天。 */
  async #replyFollowUp({ event, message }) {
    try {
      const reused = await this.#isSessionReused(event.chatId);
      const persona = reused ? null : await this.#persona();
      const transcript = await this.#recentTranscript(
        event.chatId,
        message.id,
        event.groupName,
        reused ? WECHAT_PERSONAL_COMPACT_FOLLOW_UP_LIMIT : this.#transcriptLimit,
      );
      const sections = [];
      if (persona?.text) sections.push(`<dsh_im_persona>\n${persona.text}\n</dsh_im_persona>`);
      if (transcript) sections.push(`群「${event.groupName || event.chatId}」最近聊天：\n${transcript}`);
      sections.push(`群成员 ${event.senderName} 刚刚说：\n${event.text}`);
      // TODO(识图暂停)：恢复识图时，在 prompt 中加入「对方还发送了一张图片…」并把 images 传给 generate。
      const voiceHint = this.#voiceInstruction();
      if (voiceHint) sections.push(voiceHint);
      if (this.#voice && this.#voiceMode === 'always') {
        sections.push('群里正在和你聊天。请像群友一样自然地接一句，延续对话；不要 @ 人，不要使用 Markdown，不要解释。直接输出回复正文，系统会自动把这段回复转成微信语音条。');
      } else if (this.#voice) {
        sections.push('群里正在和你聊天。请像群友一样自然地接一句，延续对话；不要 @ 人，不要使用 Markdown，不要解释。普通文字直接输出；要发语音时把朗读文字放进 <dsh_im_voice> 标签。');
      } else {
        sections.push('群里正在和你聊天。请像群友一样自然地接一句，延续对话；不要 @ 人，不要使用 Markdown，不要解释，直接输出回复正文。');
      }
      const prompt = sections.join('\n\n');
      const raw = await this.#generate({
        kind: 'follow-up',
        prompt,
        meta: { chatId: event.chatId, senderId: event.senderId, channel: 'wechat-personal' },
      });
      const text = textOf(raw);
      if (!text || text === SKIP_TOKEN || text.startsWith(SKIP_TOKEN)) return;
      if (this.#voice && this.#voiceMode === 'always') {
        const spoken = await this.#sendVoiceReply({ chatId: event.chatId, text, groupName: event.groupName });
        const leftover = textOf(spoken.remaining).slice(0, WECHAT_PERSONAL_MAX_REPLY_CHARS);
        if (spoken.sent && !leftover) return;
        if (leftover) {
          await this.#client.sendText({ threadId: event.chatId, text: leftover });
          await this.#recordBotMessage({ chatId: event.chatId, text: leftover, groupName: event.groupName });
          return;
        }
      }
      const parsed = extractVoiceTag(text);
      let voiceSent = false;
      if (parsed.voiceText) {
        voiceSent = await this.#sendVoiceNote({ chatId: event.chatId, text: parsed.voiceText, groupName: event.groupName });
        if (!voiceSent) parsed.text = textOf(parsed.text) ? `${parsed.text}\n${parsed.voiceText}` : parsed.voiceText;
      }
      const reply = textOf(parsed.text).slice(0, WECHAT_PERSONAL_MAX_REPLY_CHARS);
      if (!reply) {
        if (voiceSent) return;
        return;
      }
      await this.#client.sendText({ threadId: event.chatId, text: reply });
      await this.#recordBotMessage({ chatId: event.chatId, text: reply, groupName: event.groupName });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] follow-up reply failed:', error?.message ?? error);
    }
  }

  async #isSessionReused(chatId) {
    if (!this.#sessionExists) return false;
    try {
      return (await this.#sessionExists(chatId)) === true;
    } catch (error) {
      this.#logger.warn?.('[dsh-im:wechat-personal] unable to resolve session state:', error?.message ?? error);
      return false;
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

  async #recentTranscript(chatId, currentMessageId, groupName, limit = this.#transcriptLimit) {
    try {
      const messages = await this.#client.listMessages(chatId, { limit: limit + 1 });
      const lines = messages
        .filter((message) => message && message.id !== currentMessageId
          && (textOf(message.body) || Number(message.type) === 3))
        .slice(0, limit)
        .map((message) => (Number(message.type) === 3 && !textOf(message.body)
          ? { ...message, body: '[图片]' } : message))
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
