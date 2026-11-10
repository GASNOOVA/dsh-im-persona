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
      pendingReplies: [...this.#replyQueues.entries()]
        .filter(([, queue]) => queue.jobs.length > 0)
        .map(([chatId, queue]) => ({ chatId, count: queue.jobs.length })),
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
    let text = textOf(message.body);
    let images = [];
    if (!text && Number(message.type) === 3) {
      try {
        const image = await this.#client.downloadMessageImage?.(message.id);
        if (image?.bytes?.byteLength) {
          images = [{
            name: image.name,
            size: image.bytes.byteLength,
            load: async () => image.bytes,
          }];
          text = '[图片]';
        }
      } catch (error) {
        this.#logger.warn?.('[dsh-im:wechat-personal] unable to download image:', error?.message ?? error);
      }
    }
    if (!text) return; // 文件/语音等非文本消息暂不进入群脑。
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
      ...(images.length > 0 ? { images } : {}),
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
        images: [...(sameSender.event.images ?? []), ...(job.event.images ?? [])],
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
      sections.push(`群成员 ${event.senderName} 刚刚 @ 你：\n${event.text}`);
      if (Array.isArray(event.images) && event.images.length > 0) {
        sections.push('（对方还发送了一张图片，请结合图片内容回复。）');
      }
      if (blocks.length > 0) sections.push(...blocks);
      sections.push('请用纯文本直接回复（不要使用 Markdown 标记，不要输出解释过程）；回复要像群友聊天，简洁自然。');
      const prompt = sections.join('\n\n');
      const raw = await this.#generate({
        kind: 'direct',
        prompt,
        images: event.images ?? [],
        meta: { chatId: event.chatId, senderId: event.senderId, channel: 'wechat-personal' },
      });
      const text = textOf(raw);
      if (!text || text === SKIP_TOKEN || text.startsWith(SKIP_TOKEN)) return;
      const reply = text.slice(0, WECHAT_PERSONAL_MAX_REPLY_CHARS);
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
      if (Array.isArray(event.images) && event.images.length > 0) {
        sections.push('（对方还发送了一张图片，请结合图片内容回复。）');
      }
      sections.push('群里正在和你聊天。请像群友一样自然地接一句，延续对话；不要 @ 人，不要使用 Markdown，不要解释，直接输出回复正文。');
      const prompt = sections.join('\n\n');
      const raw = await this.#generate({
        kind: 'follow-up',
        prompt,
        images: event.images ?? [],
        meta: { chatId: event.chatId, senderId: event.senderId, channel: 'wechat-personal' },
      });
      const text = textOf(raw);
      if (!text || text === SKIP_TOKEN || text.startsWith(SKIP_TOKEN)) return;
      const reply = text.slice(0, WECHAT_PERSONAL_MAX_REPLY_CHARS);
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
