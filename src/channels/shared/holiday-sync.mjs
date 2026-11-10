/**
 * 中国法定节假日同步（「闲时启用」设置页的手动同步按钮）。
 *
 * 数据源使用 NateScarlet/holiday-cn：该仓库按年提供由国务院办公厅通知生成的
 * 放假日历 JSON（`days[].isOffDay === true` 即放假日期），我们只取这部分日期。
 * 同步动作由用户手动触发，需要网络；失败时抛错由 RPC 转成可展示的错误。
 */
import { BEIJING_UTC_OFFSET_MINUTES, normalizeHolidayDate } from './off-peak.mjs';

export const HOLIDAY_SYNC_SOURCE = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master';
export const HOLIDAY_SYNC_TIMEOUT_MS = 15_000;

/** 同步时默认抓取当前年份起连续几年（未来两年尚未发布的年份会被忽略）。 */
export const HOLIDAY_SYNC_YEARS_AHEAD = 2;

export function holidaySyncUrl(year) {
  return `${HOLIDAY_SYNC_SOURCE}/${year}.json`;
}

function beijingYear(date) {
  return new Date(date.getTime() + BEIJING_UTC_OFFSET_MINUTES * 60_000).getUTCFullYear();
}

/** 从 holiday-cn 的年度文档中取出放假日期；格式不合法返回 null。 */
export function extractHolidayDates(document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.days)) return null;
  const dates = [];
  const seen = new Set();
  for (const day of document.days) {
    if (!day || typeof day !== 'object' || day.isOffDay !== true) continue;
    const dateKey = normalizeHolidayDate(day.date);
    if (!dateKey || seen.has(dateKey)) continue;
    seen.add(dateKey);
    dates.push(dateKey);
  }
  return dates.sort();
}

async function fetchYear(year, { fetchImpl, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('holiday sync timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(holidaySyncUrl(year), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response || response.ok !== true) {
      return null;
    }
    const document = await response.json();
    return extractHolidayDates(document);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 手动同步未来数年的法定节假日日期。
 *
 * 返回 `{ holidays, years, failedYears, fetchedAt, source }`；至少一年成功即可
 * 返回结果，全部失败时抛错。`fetchImpl` 与 `now` 可用于测试注入。
 */
export async function fetchChineseHolidays({
  years,
  fetchImpl = globalThis.fetch,
  timeoutMs = HOLIDAY_SYNC_TIMEOUT_MS,
  now = () => new Date(),
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is unavailable');
  const startedAt = now();
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) {
    throw new Error('invalid current time');
  }
  const currentYear = beijingYear(startedAt);
  const requestedYears = Array.isArray(years) && years.length > 0
    ? [...new Set(years.map((year) => Number(year)).filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100))].sort()
    : Array.from({ length: HOLIDAY_SYNC_YEARS_AHEAD + 1 }, (_, offset) => currentYear + offset);

  const results = await Promise.all(
    requestedYears.map((year) => fetchYear(year, { fetchImpl, timeoutMs, signal })),
  );
  const yearsWithData = [];
  const failedYears = [];
  const seen = new Set();
  const holidays = [];
  requestedYears.forEach((year, index) => {
    const dates = results[index];
    if (!Array.isArray(dates) || dates.length === 0) {
      failedYears.push(year);
      return;
    }
    yearsWithData.push(year);
    for (const dateKey of dates) {
      if (seen.has(dateKey)) continue;
      seen.add(dateKey);
      holidays.push(dateKey);
    }
  });
  if (yearsWithData.length === 0) {
    throw new Error(`unable to fetch holidays for ${requestedYears.join(', ')}`);
  }
  return {
    holidays: holidays.sort(),
    years: yearsWithData,
    failedYears,
    fetchedAt: now().toISOString(),
    source: HOLIDAY_SYNC_SOURCE,
  };
}
