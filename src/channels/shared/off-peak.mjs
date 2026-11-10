/**
 * DeepSeek API 高峰/非高峰时段（闲时启用）。
 *
 * DeepSeek 官方优惠时段：北京时间 00:30–08:30，即 UTC 16:30–次日 00:30。
 * 其余时间（UTC 00:30–16:30）为高峰时段。窗口跨 UTC 零点，因此判断时要
 * 处理回绕；这里统一用「UTC 分钟数」比较，避免受宿主时区或夏令时影响。
 */
export const DEEPSEEK_OFF_PEAK_WINDOW = Object.freeze({
  utcStart: '16:30',
  utcEnd: '00:30',
  startMinute: 16 * 60 + 30,
  endMinute: 30,
  beijingStart: '00:30',
  beijingEnd: '08:30',
});

export const DEFAULT_OFF_PEAK_SETTINGS = Object.freeze({ enabled: false });

function utcMinuteOf(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

export function normalizeOffPeakSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.enabled !== 'boolean') return null;
  return { enabled: value.enabled };
}

/**
 * 给定时刻是否处于 DeepSeek 非高峰时段。
 * 日期非法时返回 false（fail-open：宁可照常响应，也不要因为时钟异常永久静默）。
 */
export function isOffPeakAt(date = new Date(), window = DEEPSEEK_OFF_PEAK_WINDOW) {
  const minute = utcMinuteOf(date);
  if (minute === null) return false;
  const { startMinute, endMinute } = window ?? {};
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)
    || startMinute < 0 || startMinute > 1439
    || endMinute < 0 || endMinute > 1439) {
    return false;
  }
  return startMinute <= endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/** 设置 + 当前时刻的完整状态，供设置页展示；activeNow 表示机器人此刻是否响应。 */
export function offPeakStatus(settings = DEFAULT_OFF_PEAK_SETTINGS, now = new Date()) {
  const enabled = normalizeOffPeakSettings(settings)?.enabled === true;
  const offPeakNow = isOffPeakAt(now);
  return {
    enabled,
    offPeakNow,
    activeNow: !enabled || offPeakNow,
    schedule: {
      utcStart: DEEPSEEK_OFF_PEAK_WINDOW.utcStart,
      utcEnd: DEEPSEEK_OFF_PEAK_WINDOW.utcEnd,
      beijingStart: DEEPSEEK_OFF_PEAK_WINDOW.beijingStart,
      beijingEnd: DEEPSEEK_OFF_PEAK_WINDOW.beijingEnd,
    },
  };
}

/** 入站消息是否应被静默丢弃：仅当开关开启且当前处于高峰时段。 */
export function shouldBlockInbound(settings = DEFAULT_OFF_PEAK_SETTINGS, now = new Date()) {
  const enabled = normalizeOffPeakSettings(settings)?.enabled === true;
  return enabled && !isOffPeakAt(now);
}
