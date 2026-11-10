/**
 * DeepSeek API 高峰/非高峰（闲时启用）。
 *
 * 官方规则（2026-09-19 补充说明）：北京时间周一至周五（不含中国法定节假日）
 * 09:00–12:00、14:00–18:00 为高峰时段；其余时间均为空闲时段，价格为高峰的
 * 一半。空闲时段包括：工作日 12:00–14:00 与 18:00–次日 09:00、周末全天、中国
 * 法定节假日全天。调休上班的周末也按周末计（全天空闲）。
 *
 * 判断统一换算到北京时间（UTC+8）再做，避免受宿主时区或夏令时影响。法定节假日
 * 表内置 2026、2027 两年；后续年份可在设置页点击「同步节假日」，从
 * holiday-cn（由国务院通知生成）手动同步并持久化到本机设置文件。
 */
import { t } from './i18n.mjs';

export const BEIJING_UTC_OFFSET_MINUTES = 8 * 60;

export const DEEPSEEK_PEAK_WINDOWS = Object.freeze([
  Object.freeze({ start: '09:00', startMinute: 9 * 60, end: '12:00', endMinute: 12 * 60 }),
  Object.freeze({ start: '14:00', startMinute: 14 * 60, end: '18:00', endMinute: 18 * 60 }),
]);

/** 内置节假日覆盖的年份；更晚年份通过「同步节假日」补充。 */
export const OFF_PEAK_HOLIDAY_YEARS = Object.freeze([2026, 2027]);

// 国务院办公厅 2026 年部分节假日安排（国办发明电〔2025〕7号）放假日期。
export const OFF_PEAK_HOLIDAYS_2026 = Object.freeze([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
]);

// 国务院办公厅 2027 年部分节假日安排（国办发明电〔2026〕10号）放假日期。
export const OFF_PEAK_HOLIDAYS_2027 = Object.freeze([
  '2027-01-01', '2027-01-02', '2027-01-03',
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  '2027-04-03', '2027-04-04', '2027-04-05',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09',
  '2027-09-15',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05',
  '2027-10-06', '2027-10-07',
]);

export const BUILTIN_OFF_PEAK_HOLIDAYS = Object.freeze([
  ...OFF_PEAK_HOLIDAYS_2026,
  ...OFF_PEAK_HOLIDAYS_2027,
]);

const BUILTIN_HOLIDAY_SET = new Set(BUILTIN_OFF_PEAK_HOLIDAYS);
const MAX_SYNCED_HOLIDAYS = 400;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const DEFAULT_OFF_PEAK_SETTINGS = Object.freeze({
  enabled: false,
  syncedHolidays: Object.freeze([]),
  syncedAt: null,
});

function beijingParts(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + BEIJING_UTC_OFFSET_MINUTES * 60_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return {
    year,
    month,
    day,
    weekday: shifted.getUTCDay(),
    dateKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minuteOfDay: hour * 60 + minute,
  };
}

/** 校验并归一化一个 YYYY-MM-DD 日期键；非法返回 null。 */
export function normalizeHolidayDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_KEY_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** 归一化已同步的节假日列表：接受数组，逐项校验、去重、排序。 */
export function normalizeSyncedHolidays(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const dates = [];
  const seen = new Set();
  for (const item of value) {
    const dateKey = normalizeHolidayDate(item);
    if (!dateKey) return null;
    if (seen.has(dateKey)) continue;
    seen.add(dateKey);
    dates.push(dateKey);
  }
  if (dates.length > MAX_SYNCED_HOLIDAYS) return null;
  return dates.sort();
}

/** 归一化同步时间：null 或可解析的 ISO 时间字符串；非法返回 undefined。 */
export function normalizeSyncedAt(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

/**
 * 归一化设置：enabled 必须是布尔；syncedHolidays 缺省为空数组；syncedAt 缺省
 * 为 null。返回冻结副本，避免调用方修改内部状态。
 */
export function normalizeOffPeakSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.enabled !== 'boolean') return null;
  const syncedHolidays = normalizeSyncedHolidays(value.syncedHolidays);
  if (syncedHolidays === null) return null;
  const syncedAt = normalizeSyncedAt(value.syncedAt);
  if (syncedAt === undefined) return null;
  return Object.freeze({
    enabled: value.enabled,
    syncedHolidays: Object.freeze(syncedHolidays),
    syncedAt,
  });
}

function holidaySetOf(settings) {
  if (!settings) return BUILTIN_HOLIDAY_SET;
  const synced = Array.isArray(settings.syncedHolidays) ? settings.syncedHolidays : [];
  if (synced.length === 0) return BUILTIN_HOLIDAY_SET;
  return new Set([...BUILTIN_OFF_PEAK_HOLIDAYS, ...synced]);
}

/**
 * 给定时刻是否处于 DeepSeek 高峰时段。
 * 规则：北京时间周一至周五、非法定节假日、且落在 09:00–12:00 或 14:00–18:00。
 * 日期非法时返回 false（fail-open：宁可照常响应，也不要因时钟异常永久静默）。
 */
export function isPeakAt(date = new Date(), settings = DEFAULT_OFF_PEAK_SETTINGS) {
  const parts = beijingParts(date);
  if (!parts) return false;
  if (parts.weekday === 0 || parts.weekday === 6) return false; // 周末全天空闲
  if (holidaySetOf(normalizeOffPeakSettings(settings) ?? DEFAULT_OFF_PEAK_SETTINGS).has(parts.dateKey)) {
    return false; // 法定节假日全天空闲
  }
  return DEEPSEEK_PEAK_WINDOWS.some(
    (window) => parts.minuteOfDay >= window.startMinute && parts.minuteOfDay < window.endMinute,
  );
}

/** 给定时刻是否处于非高峰时段（含周末、法定节假日、工作日的非高峰窗口）。 */
export function isOffPeakAt(date = new Date(), settings = DEFAULT_OFF_PEAK_SETTINGS) {
  const parts = beijingParts(date);
  if (!parts) return false;
  return !isPeakAt(date, settings);
}

/** 设置 + 当前时刻的完整状态，供设置页展示；activeNow 表示机器人此刻是否响应。 */
export function offPeakStatus(settings = DEFAULT_OFF_PEAK_SETTINGS, now = new Date()) {
  const normalized = normalizeOffPeakSettings(settings) ?? DEFAULT_OFF_PEAK_SETTINGS;
  const peakNow = isPeakAt(now, normalized);
  const holidayDates = [...new Set([
    ...BUILTIN_OFF_PEAK_HOLIDAYS,
    ...normalized.syncedHolidays,
  ])].sort();
  return {
    enabled: normalized.enabled === true,
    offPeakNow: !peakNow,
    activeNow: normalized.enabled !== true || !peakNow,
    schedule: {
      timezone: 'Asia/Shanghai (UTC+8)',
      peakWindows: DEEPSEEK_PEAK_WINDOWS.map(({ start, end }) => ({ start, end })),
      weekdays: '周一至周五',
      weekendOffPeak: true,
      holidaysOffPeak: true,
      builtinHolidayYears: [...OFF_PEAK_HOLIDAY_YEARS],
      holidayDates,
      syncedHolidays: [...normalized.syncedHolidays],
      syncedAt: normalized.syncedAt,
    },
  };
}

/**
 * 静默期间给聊天对象的固定回复（不调用 API）：同一会话两次回复至少间隔
 * 5 分钟，避免每个被丢弃的消息都刷屏。
 */
export const OFF_PEAK_SLEEP_REPLY_MIN_INTERVAL_MS = 5 * 60_000;

export function offPeakSleepReplyText() {
  return t('大肥鱼正在睡觉中，暂时没法回复消息，等空闲时段再来找我吧～');
}

/** 入站消息是否应被静默丢弃：仅当开关开启且当前处于高峰时段。 */
export function shouldBlockInbound(settings = DEFAULT_OFF_PEAK_SETTINGS, now = new Date()) {
  const normalized = normalizeOffPeakSettings(settings);
  return normalized?.enabled === true && isPeakAt(now, normalized);
}
