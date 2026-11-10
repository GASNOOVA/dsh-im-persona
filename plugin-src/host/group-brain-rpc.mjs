// 群聊大脑的设置与状态 RPC。
//
// 与 inbound-ttl / image-input / group-history / off-peak 一样，挂在全局的
// `/dsh-im-settings` 复合通道上；客户端通用设置页里的「群聊大脑」面板直接
// 调用这些端点。保存后会要求进程内已创建的 brain 重新读取配置（群白名单、
// 静默窗口、整理间隔等），不需要重连机器人。

import {
  getGroupBrainSettingsStore,
  normalizeGroupBrainSettings,
} from '../../src/channels/shared/group-brain/group-brain-config.mjs';
import {
  listHostGroupBrains,
  reloadHostGroupBrains,
} from './group-brain-runtime.mjs';

export const GROUP_BRAIN_RPC_CHANNEL = '/dsh-im-settings';

export const GROUP_BRAIN_ENDPOINTS = Object.freeze({
  get: 'settings.group-brain.get',
  set: 'settings.group-brain.set',
  status: 'settings.group-brain.status',
  consolidate: 'settings.group-brain.consolidate',
});

const SET_KEYS = new Set(['enabled', 'maxMembers', 'allowedGroups', 'ambient', 'memory', 'profiles']);

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message } };
}

function safeStatus(brain) {
  try {
    return brain.status();
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

function findBrain(channel, botId) {
  return listHostGroupBrains().find((brain) => brain?.channel === channel && brain?.botId === botId) ?? null;
}

/**
 * @param {object} options
 * @param {object} options.config - 插件配置（读取 dshHome 等）。
 * @param {object} [options.logger]
 * @param {object} [options.store] - 测试注入。
 * @param {() => object[]} [options.listBrains] - 测试注入。
 * @param {() => Promise<void>} [options.reloadBrains] - 测试注入。
 */
export function createGroupBrainRpcHandler({
  config = {},
  logger = console,
  store = null,
  listBrains = listHostGroupBrains,
  reloadBrains = reloadHostGroupBrains,
} = {}) {
  const settingsStore = store ?? getGroupBrainSettingsStore(config);
  return async function groupBrainRpc(endpoint, payload, signal) {
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'Request cancelled.' } };
    }
    try {
      if (endpoint === GROUP_BRAIN_ENDPOINTS.get) {
        if (isPlainRecord(payload) && Object.keys(payload).length > 0) return badRequest('Invalid group brain request.');
        return { ok: true, value: await settingsStore.get() };
      }
      if (endpoint === GROUP_BRAIN_ENDPOINTS.set) {
        if (!isPlainRecord(payload)) return badRequest('Invalid group brain settings.');
        const unknown = Object.keys(payload).filter((key) => !SET_KEYS.has(key));
        if (unknown.length > 0) return badRequest('Invalid group brain settings.');
        const current = await settingsStore.get();
        const merged = normalizeGroupBrainSettings({ ...current, ...payload });
        if (!merged) return badRequest('Invalid group brain settings.');
        const saved = await settingsStore.set(merged);
        await reloadBrains().catch((error) => {
          logger?.warn?.('[dsh-im] group brain reload failed:', error?.message ?? error);
        });
        return { ok: true, value: saved };
      }
      if (endpoint === GROUP_BRAIN_ENDPOINTS.status) {
        if (isPlainRecord(payload) && Object.keys(payload).length > 0) return badRequest('Invalid group brain request.');
        const settings = await settingsStore.get();
        return {
          ok: true,
          value: {
            settings,
            brains: listBrains().map((brain) => ({
              channel: brain?.channel,
              botId: brain?.botId,
              status: safeStatus(brain),
            })),
          },
        };
      }
      if (endpoint === GROUP_BRAIN_ENDPOINTS.consolidate) {
        if (!isPlainRecord(payload)) return badRequest('Invalid group brain request.');
        const channel = typeof payload.channel === 'string' ? payload.channel : 'qq';
        const botId = typeof payload.botId === 'string' ? payload.botId : '';
        const chatId = typeof payload.chatId === 'string' ? payload.chatId : '';
        const brains = listBrains();
        if (chatId) {
          const brain = findBrainIn(brains, channel, botId);
          if (!brain) return { ok: false, error: { code: 'unknown-brain', message: 'Group brain is not running.' } };
          const result = await brain.forceConsolidate(chatId);
          if (result?.ok === false && result.reason === 'unknown-group') {
            return { ok: false, error: { code: 'unknown-group', message: 'Unknown group.' } };
          }
          return { ok: true, value: result };
        }
        const results = [];
        for (const brain of brains) {
          if (typeof brain?.maybeConsolidateAll !== 'function') continue;
          results.push({ channel: brain.channel, botId: brain.botId, result: await brain.maybeConsolidateAll({ force: true }) });
        }
        return { ok: true, value: { results } };
      }
      return badRequest('Unknown group brain endpoint.');
    } catch (error) {
      logger?.warn?.('[dsh-im] group brain rpc failed:', error?.message ?? error);
      return {
        ok: false,
        error: { code: 'group-brain-unavailable', message: '群聊大脑设置暂不可用，请稍后重试。' },
      };
    }
  };
}

function findBrainIn(brains, channel, botId) {
  return brains.find((brain) => brain?.channel === channel && (!botId || brain?.botId === botId)) ?? null;
}
