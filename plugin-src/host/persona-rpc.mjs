// 人设配置与人设库的 Host 管理 RPC。
//
// 通道：`/api/dsh-im/persona`（PERSONA_RPC_CHANNEL='/persona' + management-rpc
// 的既有品牌前缀），独立于渠道挂载，微信与 QQ 共用。
//
// 端点：
// - bot.persona.get / bot.persona.set：每机器人 v2 配置（library | inline）；
// - persona.library.list：元数据（不含正文）；
// - persona.library.get：按 id 拉取单条正文；
// - persona.library.import / rename / remove：管理用户导入项（builtin/config 只读）。
//
// 所有端点都走 management RPC 的既有鉴权（rpcAuthority）；处理器只做「载荷校验 →
// 读写 store/library → 返回标准化结果」，不接触渠道控制器，也不把磁盘细节暴露给 UI。

import { registerManagementRpc } from '../management-rpc.mjs';
import {
  DEFAULT_PERSONA_CONFIG,
  PERSONA_ENDPOINTS,
  PERSONA_LIBRARY_ENDPOINTS,
  PERSONA_LIBRARY_ID_PATTERN,
  PERSONA_RPC_CHANNEL,
  validatePersonaConfig,
} from '../../src/channels/shared/persona.mjs';
import { getPersonaStore } from '../../src/channels/shared/persona-store.mjs';
import { getPersonaLibrary } from '../../src/channels/shared/persona-library.mjs';

export {
  PERSONA_ENDPOINTS,
  PERSONA_LIBRARY_ENDPOINTS,
  PERSONA_RPC_CHANNEL,
};

/** 与机器人标识的既有约束一致。 */
const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const PERSONA_ENDPOINT_SET = new Set([
  PERSONA_ENDPOINTS.get,
  PERSONA_ENDPOINTS.set,
  PERSONA_LIBRARY_ENDPOINTS.list,
  PERSONA_LIBRARY_ENDPOINTS.get,
  PERSONA_LIBRARY_ENDPOINTS.import,
  PERSONA_LIBRARY_ENDPOINTS.rename,
  PERSONA_LIBRARY_ENDPOINTS.remove,
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validBotId(value) {
  return typeof value === 'string' && BOT_ID.test(value);
}

function validLibraryId(value) {
  return typeof value === 'string' && PERSONA_LIBRARY_ID_PATTERN.test(value);
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function libraryInput(value) {
  if (!hasExactKeys(value, ['name', 'text'])) return null;
  if (typeof value.name !== 'string' || typeof value.text !== 'string') return null;
  return { name: value.name, text: value.text };
}

/**
 * 校验一个管理 RPC 载荷。
 *
 * 每个端点只接受自己的字段集合；未知端点、多余/缺失字段一律无效，避免处理器
 * 变成「顺手多做一个操作」的入口。
 */
export function validPersonaPayload(endpoint, payload) {
  if (!isRecord(payload)) return false;
  if (!PERSONA_ENDPOINT_SET.has(endpoint)) return false;
  if (endpoint === PERSONA_ENDPOINTS.get) {
    return hasExactKeys(payload, ['botId']) && validBotId(payload.botId);
  }
  if (endpoint === PERSONA_ENDPOINTS.set) {
    if (!hasExactKeys(payload, ['botId', 'persona']) || !validBotId(payload.botId)) return false;
    try {
      validatePersonaConfig(payload.persona);
      return true;
    } catch {
      return false;
    }
  }
  if (endpoint === PERSONA_LIBRARY_ENDPOINTS.list) return hasExactKeys(payload, []);
  if (endpoint === PERSONA_LIBRARY_ENDPOINTS.get) {
    return hasExactKeys(payload, ['id']) && validLibraryId(payload.id);
  }
  if (endpoint === PERSONA_LIBRARY_ENDPOINTS.import) {
    return hasExactKeys(payload, ['name', 'text']) && libraryInput(payload) !== null;
  }
  if (endpoint === PERSONA_LIBRARY_ENDPOINTS.rename) {
    return hasExactKeys(payload, ['id', 'name'])
      && validLibraryId(payload.id) && typeof payload.name === 'string';
  }
  // remove
  return hasExactKeys(payload, ['id']) && validLibraryId(payload.id);
}

/** 把处理器内部错误映射为管理 RPC 错误码与可直接展示的文案。 */
function rpcError(error) {
  const code = error?.code;
  if (code === 'persona-config-invalid' || code === 'persona-invalid'
    || code === 'persona-invalid-bot' || code === 'persona-library-invalid'
    || code === 'persona-library-readonly' || code === 'persona-library-not-found'
    || code === 'persona-library-limit') {
    return failure('bad-request', typeof error.message === 'string'
      ? error.message
      : '人设设置无效。');
  }
  return failure('persona-settings-unavailable', '无法读取或保存人设设置，请稍后重试。');
}

/**
 * 创建与管理载体签名一致的 RPC 处理器（`(endpoint, payload, signal)`）。
 *
 * @param store - `PersonaStore`（每机器人 v2 配置）。
 * @param options.library - `PersonaLibrary`；缺省时 set 不校验库存在性（测试可用）。
 */
export function createPersonaRpcHandler(store, { library = null } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.setPersona !== 'function') {
    throw new TypeError('persona store is required');
  }
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return failure('cancelled', '请求已取消。');
    if (!validPersonaPayload(endpoint, payload)) {
      const message = endpoint === PERSONA_ENDPOINTS.get
        ? '人设读取请求无效。'
        : endpoint === PERSONA_ENDPOINTS.set
          ? '请提交完整有效的人设设置。'
          : '人设库请求无效。';
      return failure('bad-request', message);
    }
    try {
      if (endpoint === PERSONA_ENDPOINTS.get) {
        return { ok: true, value: { persona: await store.get(payload.botId) } };
      }
      if (endpoint === PERSONA_ENDPOINTS.set) {
        if (payload.persona.source === 'library') {
          // 允许库尚未加载（例如 Host 启动早期），但选中的条目必须可解析。
          const entry = typeof library?.entryFor === 'function'
            ? library.entryFor(payload.persona.personaId)
            : null;
          if (!entry) return failure('bad-request', '选择的人设不存在，请重新选择。');
        }
        if (payload.persona.source === 'inline') {
          // 内联来源至少要有一项内容，避免保存一个「启用但永远不注入」的配置。
          const { name, tone, instructions, enabled } = payload.persona;
          if (enabled === true && !name && !tone && !instructions) {
            return failure('bad-request', '启用自定义人设时请至少填写一项内容。');
          }
        }
        return { ok: true, value: { persona: await store.setPersona(payload.botId, payload.persona) } };
      }
      if (!library) return rpcError(Object.assign(new Error('persona library unavailable'), { code: 'persona-library-unavailable' }));
      if (endpoint === PERSONA_LIBRARY_ENDPOINTS.list) {
        return { ok: true, value: { entries: library.list() } };
      }
      if (endpoint === PERSONA_LIBRARY_ENDPOINTS.get) {
        return { ok: true, value: { entry: await library.get(payload.id) } };
      }
      if (endpoint === PERSONA_LIBRARY_ENDPOINTS.import) {
        return { ok: true, value: { entry: await library.importEntry(libraryInput(payload)) } };
      }
      if (endpoint === PERSONA_LIBRARY_ENDPOINTS.rename) {
        return { ok: true, value: { entry: await library.rename(payload.id, payload.name) } };
      }
      await library.remove(payload.id);
      return { ok: true, value: { removed: true } };
    } catch (error) {
      return rpcError(error);
    }
  };
}

/**
 * 在当前 Host 上安装人设 + 人设库管理 RPC。
 *
 * store 与 library 默认取当前 DSH home 的单例：与渠道注入读到的是同一份快照；
 * 人设库会先加载（builtin/config 条目在加载时可用），失败不影响 RPC 安装。
 * 返回幂等清理函数。
 */
export function installPersonaRpc(ctx, { authority, config = {}, store, library } = {}) {
  const personaStore = store ?? getPersonaStore(config);
  const personaLibrary = library ?? getPersonaLibrary(config);
  const handler = createPersonaRpcHandler(personaStore, { library: personaLibrary });
  // 预热人设库，让 set 的库存在性校验与注入解析用同一份已加载快照。
  void personaLibrary.load().catch(() => undefined);
  const dispose = registerManagementRpc(ctx, PERSONA_RPC_CHANNEL, handler, { authority });
  return () => {
    if (typeof dispose === 'function') dispose();
    else dispose?.dispose?.();
  };
}

// 供测试与调用方参照的默认值（store 读取时同样会回落它）。
export { DEFAULT_PERSONA_CONFIG };
