import {
  normalizeOffPeakSettings,
  offPeakStatus,
} from '../../src/channels/shared/off-peak.mjs';
import { fetchChineseHolidays } from '../../src/channels/shared/holiday-sync.mjs';

export const OFF_PEAK_ENDPOINTS = Object.freeze({
  get: 'settings.off-peak.get',
  set: 'settings.off-peak.set',
  syncHolidays: 'settings.off-peak.sync-holidays',
});

const ENDPOINTS = new Set(Object.values(OFF_PEAK_ENDPOINTS));
const SET_KEYS = new Set(['enabled']);

export function validOffPeakPayload(endpoint, payload) {
  if (!ENDPOINTS.has(endpoint)) return false;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (endpoint === OFF_PEAK_ENDPOINTS.set) {
    if (!keys.includes('enabled')) return false;
    if (keys.some((key) => !SET_KEYS.has(key))) return false;
    return typeof payload.enabled === 'boolean';
  }
  return keys.length === 0;
}

/**
 * 闲时启用设置 RPC。它是全局设置，与入站附件保留时长等共用
 * `/dsh-im-settings` 复合通道，因此返回结构与其它设置处理器保持一致：
 * 成功 `{ok:true,value}`，失败 `{ok:false,error:{code,message}}`。
 *
 * `syncHolidays` 可注入用于测试；默认从 holiday-cn 拉取当前及未来两年的放假
 * 日期并写入设置文件。同步失败只影响本次同步，不改变已有的节假日表。
 */
export function createOffPeakRpcHandler(
  store,
  { now = () => new Date(), syncHolidays = null } = {},
) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('createOffPeakRpcHandler requires an off-peak settings store');
  }
  const runSync = syncHolidays ?? (() => fetchChineseHolidays({ now }));
  return async (endpoint, payload, signal) => {
    if (!validOffPeakPayload(endpoint, payload)) {
      return { ok: false, error: { code: 'bad-request', message: 'Invalid off-peak settings request.' } };
    }
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'Request cancelled.' } };
    }
    try {
      if (endpoint === OFF_PEAK_ENDPOINTS.get) {
        return { ok: true, value: offPeakStatus(await store.get(), now()) };
      }
      if (endpoint === OFF_PEAK_ENDPOINTS.syncHolidays) {
        const current = await store.get();
        const synced = await runSync();
        const saved = await store.set(normalizeOffPeakSettings({
          enabled: current.enabled === true,
          syncedHolidays: synced.holidays,
          syncedAt: synced.fetchedAt,
        }));
        return {
          ok: true,
          value: {
            ...offPeakStatus(saved, now()),
            synced: {
              years: synced.years,
              failedYears: synced.failedYears,
              fetchedAt: synced.fetchedAt,
              source: synced.source,
            },
          },
        };
      }
      // 切换开关时保留已同步的节假日表，避免一次保存清空同步结果。
      const current = await store.get();
      const settings = normalizeOffPeakSettings({
        enabled: payload.enabled,
        syncedHolidays: current?.syncedHolidays,
        syncedAt: current?.syncedAt,
      });
      return { ok: true, value: offPeakStatus(await store.set(settings), now()) };
    } catch (error) {
      const syncFailed = endpoint === OFF_PEAK_ENDPOINTS.syncHolidays;
      return {
        ok: false,
        error: {
          code: syncFailed ? 'holiday-sync-failed' : 'off-peak-settings-unavailable',
          message: syncFailed
            ? '节假日同步失败，请检查网络后重试。'
            : '闲时启用设置暂不可用，请稍后重试。',
        },
      };
    }
  };
}
