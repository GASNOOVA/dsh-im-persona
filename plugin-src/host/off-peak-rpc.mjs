import {
  normalizeExtraHolidays,
  normalizeOffPeakSettings,
  offPeakStatus,
} from '../../src/channels/shared/off-peak.mjs';

export const OFF_PEAK_ENDPOINTS = Object.freeze({
  get: 'settings.off-peak.get',
  set: 'settings.off-peak.set',
});

const ENDPOINTS = new Set(Object.values(OFF_PEAK_ENDPOINTS));
const SET_KEYS = new Set(['enabled', 'extraHolidays']);

export function validOffPeakPayload(endpoint, payload) {
  if (!ENDPOINTS.has(endpoint)) return false;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (endpoint === OFF_PEAK_ENDPOINTS.set) {
    if (!keys.includes('enabled')) return false;
    if (keys.some((key) => !SET_KEYS.has(key))) return false;
    return typeof payload.enabled === 'boolean'
      && (payload.extraHolidays === undefined || normalizeExtraHolidays(payload.extraHolidays) !== null);
  }
  return keys.length === 0;
}

/**
 * 闲时启用设置 RPC。它是全局设置，与入站附件保留时长等共用
 * `/dsh-im-settings` 复合通道，因此返回结构与其它设置处理器保持一致：
 * 成功 `{ok:true,value}`，失败 `{ok:false,error:{code,message}}`。
 */
export function createOffPeakRpcHandler(store, { now = () => new Date() } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('createOffPeakRpcHandler requires an off-peak settings store');
  }
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
      // 只更新显式传入的字段，避免「切换开关」覆盖掉用户在文本框里维护的额外节假日。
      const current = await store.get();
      const settings = normalizeOffPeakSettings({
        enabled: payload.enabled,
        extraHolidays: payload.extraHolidays ?? current?.extraHolidays,
      });
      return { ok: true, value: offPeakStatus(await store.set(settings), now()) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'off-peak-settings-unavailable',
          message: '闲时启用设置暂不可用，请稍后重试。',
        },
      };
    }
  };
}
