// 群聊「自动接话」触发引擎：静默计时 + 限流决策。
//
// 职责只有一件事：根据逐条入站消息维护每个群的缓冲与静默定时器，在群聊安静下来后
// 判断「现在是否适合让 bot 主动接一句」。它不接触网络、存储、模型与会话，所有时间
// 与定时器都可注入，便于单测。真正生成/发送由上层（群聊大脑编排）负责。
//
// 参数语义（与 group-brain-config 的 ambient 字段一一对应）：
// - silenceMs：最后一条消息之后安静多久触发评估；
// - minMessages：一个静默窗口内至少要有多少条消息（防「两个人一问一答也接话」）；
// - cooldownMs：两次主动接话之间的最小间隔；
// - maxPerHour / maxPerDay：限流窗口内最多主动接话次数（滑动窗口）；
// - followUpMs / followUpMaxReplies / followUpMinIntervalMs：被 @ 之后的连续对话
//   窗口。窗口内未 @ 的消息也可以直接触发一次自然回复，形成连续聊天效果。

/** 默认触发参数（冻结，供配置缺省合并）。 */
export const DEFAULT_GROUP_TRIGGER = Object.freeze({
  silenceMs: 120_000,
  minMessages: 2,
  cooldownMs: 600_000,
  maxPerHour: 4,
  maxPerDay: 40,
  followUpMs: 300_000,
  followUpMaxReplies: 8,
  followUpMinIntervalMs: 8_000,
});

/** 限流窗口长度（毫秒）。 */
export const GROUP_TRIGGER_WINDOWS = Object.freeze({
  hour: 3_600_000,
  day: 86_400_000,
});

// 字段校验规则：min 为下限（闭区间）。silenceMs/minMessages/maxPerHour/maxPerDay
// 要求正整数，cooldownMs 允许 0（便于测试与「关闭冷却」配置）。
const FIELD_RULES = Object.freeze({
  silenceMs: 1,
  minMessages: 1,
  cooldownMs: 0,
  maxPerHour: 1,
  maxPerDay: 1,
  followUpMs: 0,
  followUpMaxReplies: 0,
  followUpMinIntervalMs: 0,
});

const FIELD_NAMES = Object.freeze(Object.keys(FIELD_RULES));

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidInteger(value, min) {
  return Number.isInteger(value) && value >= min;
}

/**
 * 归一化触发参数：缺省字段合并 DEFAULT_GROUP_TRIGGER；任何字段非法（非整数、
 * 越界、NaN/Infinity）整个返回 null，由调用方决定告警或回退默认值。
 */
export function normalizeGroupTriggerSettings(value) {
  if (!isPlainRecord(value)) return null;
  const normalized = {};
  for (const field of FIELD_NAMES) {
    const raw = value[field];
    if (raw === undefined) {
      normalized[field] = DEFAULT_GROUP_TRIGGER[field];
      continue;
    }
    if (!isValidInteger(raw, FIELD_RULES[field])) return null;
    normalized[field] = raw;
  }
  return Object.freeze(normalized);
}

/**
 * 每群触发状态机。
 *
 * 使用方：每收到一条群消息调用 observe；引擎自己管理静默定时器；定时器到期后
 * 通过 onAmbient(chatId, info) 通知上层「可以接话了」。上层可随时用 status 查看
 * 状态、用 dispose 清理（机器人删除 / 群被移出白名单 / 插件卸载）。
 */
export class GroupTriggerEngine {
  #settings;
  #now;
  #setTimeout;
  #clearTimeout;
  #onAmbient;
  #logger;
  #states = new Map();

  constructor({
    settings = DEFAULT_GROUP_TRIGGER,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onAmbient = () => {},
    logger = console,
  } = {}) {
    const normalized = normalizeGroupTriggerSettings(settings);
    if (!normalized) {
      logger?.warn?.('[dsh-im] 群聊触发参数非法，已回退默认值。');
      this.#settings = DEFAULT_GROUP_TRIGGER;
    } else {
      this.#settings = normalized;
    }
    this.#now = now;
    this.#setTimeout = setTimeoutFn;
    this.#clearTimeout = clearTimeoutFn;
    this.#onAmbient = onAmbient;
    this.#logger = logger;
  }

  /** 当前生效的（归一化）参数。 */
  get settings() {
    return this.#settings;
  }

  #stateFor(chatId) {
    let state = this.#states.get(chatId);
    if (!state) {
      state = {
        buffer: [],
        timer: null,
        lastAmbientAt: null,
        ambientAt: [],
        followUpUntil: 0,
        followUpReplies: 0,
        lastFollowUpAt: null,
        lastBotReplyAt: null,
      };
      this.#states.set(chatId, state);
    }
    return state;
  }

  #clearTimer(state) {
    if (state.timer !== null) {
      this.#clearTimeout(state.timer);
      state.timer = null;
    }
  }

  /**
   * 记录一条群消息。
   *
   * - 被 @：这是直接请求，立刻取消该群的静默计时、清空缓冲，返回 'direct'；
   * - 未 @：入缓冲并重置静默计时，返回 'record'。
   *
   * `at` 缺省用注入的 now()；senderId/senderName 只用于后续 info，不做身份校验。
   */
  observe({ chatId, mentionedBot = false, at, senderId = '', senderName = '' } = {}) {
    if (typeof chatId !== 'string' || !chatId.trim()) {
      throw new TypeError('group trigger requires a chatId');
    }
    const timestamp = Number.isFinite(at) ? at : this.#now();
    const state = this.#stateFor(chatId);

    if (mentionedBot) {
      this.#clearTimer(state);
      state.buffer = [];
      state.followUpUntil = this.#settings.followUpMs > 0
        ? timestamp + this.#settings.followUpMs
        : 0;
      state.followUpReplies = 0;
      state.lastFollowUpAt = null;
      return 'direct';
    }

    state.buffer.push({
      at: timestamp,
      senderId: typeof senderId === 'string' ? senderId : String(senderId ?? ''),
      senderName: typeof senderName === 'string' ? senderName : String(senderName ?? ''),
    });
    this.#clearTimer(state);
    const timer = this.#setTimeout(() => {
      state.timer = null;
      this.#evaluate(chatId);
    }, this.#settings.silenceMs);
    // Node 定时器不阻止进程退出；fake timer 的句柄可能是数字，这里做兼容。
    if (typeof timer?.unref === 'function') timer.unref();
    state.timer = timer;
    if (this.#claimFollowUp(state, timestamp)) return 'followUp';
    return 'record';
  }

  /** 判断并占用一次「连续对话窗口」内的自动回复额度。 */
  #claimFollowUp(state, timestamp) {
    const { followUpMs, followUpMaxReplies, followUpMinIntervalMs } = this.#settings;
    if (followUpMs <= 0 || followUpMaxReplies <= 0) return false;
    if (!(state.followUpUntil > timestamp)) return false;
    if (state.followUpReplies >= followUpMaxReplies) return false;
    if (state.lastFollowUpAt !== null && timestamp - state.lastFollowUpAt < followUpMinIntervalMs) {
      return false;
    }
    state.followUpReplies += 1;
    state.lastFollowUpAt = timestamp;
    state.lastBotReplyAt = timestamp;
    return true;
  }

  /**
   * 公开的评估入口（测试可直接给 now，避免依赖定时器）：
   * 无论当前是否有待触发的定时器，都立即评估一次，并清掉该群的静默定时器。
   * 返回触发信息；未通过限制返回 null。
   */
  evaluate(chatId, { now } = {}) {
    if (typeof chatId !== 'string' || !chatId.trim()) {
      throw new TypeError('group trigger requires a chatId');
    }
    return this.#evaluate(chatId, Number.isFinite(now) ? now : undefined);
  }

  #evaluate(chatId, at) {
    const state = this.#states.get(chatId);
    if (!state) return null;
    this.#clearTimer(state);

    const now = Number.isFinite(at) ? at : this.#now();
    const { minMessages, cooldownMs, maxPerHour, maxPerDay } = this.#settings;
    const messages = state.buffer;
    // 防抖：无论这次是否触发，窗口都结束；下次从新消息重新累计。
    state.buffer = [];

    if (messages.length < minMessages) return null;
    const lastBotReplyAt = Math.max(state.lastAmbientAt ?? 0, state.lastBotReplyAt ?? 0);
    if (lastBotReplyAt > 0 && now - lastBotReplyAt < cooldownMs) return null;

    // 只保留近 24h 记录（滑动窗口），再判断小时/日上限。
    state.ambientAt = state.ambientAt.filter((time) => now - time < GROUP_TRIGGER_WINDOWS.day);
    const hourlyCount = state.ambientAt.filter((time) => now - time < GROUP_TRIGGER_WINDOWS.hour).length;
    if (hourlyCount >= maxPerHour) return null;
    if (state.ambientAt.length >= maxPerDay) return null;

    state.lastAmbientAt = now;
    state.ambientAt.push(now);

    const senders = [];
    const seenSenders = new Set();
    for (const message of messages) {
      const name = message.senderName || message.senderId;
      if (!name || seenSenders.has(name)) continue;
      seenSenders.add(name);
      senders.push(name);
    }

    const info = Object.freeze({
      messageCount: messages.length,
      senders: Object.freeze(senders),
      fromAt: messages[0]?.at ?? now,
      toAt: messages[messages.length - 1]?.at ?? now,
    });

    try {
      this.#onAmbient(chatId, info);
    } catch (error) {
      // 上层回调异常不能影响触发引擎本身（否则后续消息的定时器会连锁失败）。
      this.#logger?.error?.('[dsh-im] 群聊接话回调执行失败。', error);
    }
    return info;
  }

  /** 查看某群当前状态；未知群返回空状态。 */
  status(chatId) {
    const state = this.#states.get(chatId);
    if (!state) {
      return {
        buffered: 0,
        lastAmbientAt: null,
        hourlyCount: 0,
        dailyCount: 0,
        pendingTimer: false,
        followUp: { active: false, remainingReplies: 0 },
      };
    }
    const now = this.#now();
    const daily = state.ambientAt.filter((time) => now - time < GROUP_TRIGGER_WINDOWS.day);
    return {
      buffered: state.buffer.length,
      lastAmbientAt: state.lastAmbientAt,
      hourlyCount: daily.filter((time) => now - time < GROUP_TRIGGER_WINDOWS.hour).length,
      dailyCount: daily.length,
      pendingTimer: state.timer !== null,
      followUp: {
        active: this.#settings.followUpMs > 0 && state.followUpUntil > now,
        remainingReplies: Math.max(0, this.#settings.followUpMaxReplies - state.followUpReplies),
      },
    };
  }

  /**
   * 清理定时器：传具体 chatId 只清该群（并清缓冲）；传 '*'（默认）清所有群。
   * 机器人删除、群移出白名单、插件停用时调用。
   */
  dispose(chatId = '*') {
    if (chatId === '*') {
      for (const state of this.#states.values()) {
        this.#clearTimer(state);
        state.buffer = [];
      }
      this.#states.clear();
      return;
    }
    const state = this.#states.get(chatId);
    if (!state) return;
    this.#clearTimer(state);
    state.buffer = [];
    this.#states.delete(chatId);
  }
}
