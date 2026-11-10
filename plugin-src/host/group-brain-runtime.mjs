// 群聊大脑的 Host 侧适配：模型生成、运行时注册表与设置热更新。
//
// `GroupBrain` 本身不依赖 Harness 的具体形态，只要求 generate/send 两个回调；
// 本文件负责把 DSH 会话包装成 generate，并把各渠道创建出来的 brain 实例登记到
// 进程内注册表，供设置 RPC 统一读取状态/热更新配置。
//
// 会话策略：
// - 同一个群（channel + botId + chatId）的所有群聊回复复用同一个 DSH 会话，
//   让模型看到自己之前的发言，形成连贯的群聊上下文；会话掉队/被归档时自动
//   重建并更新登记表；
// - 记忆整理（kind='consolidate'）仍使用一次性会话：它是内部管理任务，材料
//   由 prompt 自带，不需要占用群聊会话的上下文。

import { GroupBrain } from '../../src/channels/shared/group-brain/group-brain.mjs';
import { getGroupBrainSettingsStore } from '../../src/channels/shared/group-brain/group-brain-config.mjs';
import { getGroupBrainSessionRegistry, groupBrainSessionKey } from './group-brain-sessions.mjs';

const brains = new Map();

function brainKey(channel, botId) {
  return `${channel}\u0000${botId}`;
}

function sessionTitle(kind, groupName) {
  const label = kind === 'consolidate' ? '记忆整理' : kind === 'ambient' ? '群聊接话' : '群聊';
  const name = typeof groupName === 'string' ? groupName.trim().slice(0, 40) : '';
  return `${label}${name ? ` · ${name}` : ''}`.slice(0, 80);
}

/** 统一群聊会话的标题：整个群共用一个「群聊 · 群名」会话。 */
export function persistentGroupSessionTitle(groupName) {
  const name = typeof groupName === 'string' ? groupName.trim().slice(0, 40) : '';
  return (name ? `群聊 · ${name}` : '群聊会话').slice(0, 80);
}

const MISSING_SESSION_CODES = new Set([
  'session-not-found',
  'session-not_found',
  'unknown-session',
  'no-such-session',
  'not-found',
]);

/**
 * Harness 在会话被删除/归档后再次 prompt 会失败；识别「会话不存在」这一
 * 类错误后重建会话。其它错误（模型/网络/审批）不重试，避免重复扣费。
 */
export function isMissingSessionError(error) {
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  if (MISSING_SESSION_CODES.has(code)) return true;
  const message = typeof error?.message === 'string' ? error.message : '';
  return /session/i.test(message) && /(not found|unknown|does not exist|no such|已不存在)/i.test(message);
}

async function askSession(harness, sessionId, prompt, timeoutMs, images = []) {
  return harness.ask(sessionId, prompt, {
    timeoutMs,
    progressMode: 'latest',
    finalAnswerOnly: true,
    ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
  });
}

/**
 * 用 Harness Session 实现 generate：
 * - 群聊回复（direct/follow-up/ambient）：同一群复用同一个会话；
 * - 记忆整理：一次性会话，问完归档。
 *
 * @param {object} options
 * @param {object} options.harness - HarnessClient（需提供 createSession/ask；
 *   renameSession/archiveWorkspaceSession 为可选能力）。
 * @param {object} [options.logger]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.channel] - 用于统一会话登记（不传则退化为一次性会话）。
 * @param {string} [options.botId]
 * @param {string} [options.dshHome] - 登记表所在数据目录。
 * @param {object} [options.registry] - 测试注入的 GroupBrainSessionRegistry。
 * @returns {(request: {kind: string, prompt: string, meta?: object}) => Promise<string>}
 */
export function createHarnessGroupBrainGenerator({
  harness,
  logger = console,
  timeoutMs = 180_000,
  channel = null,
  botId = null,
  dshHome = null,
  registry = null,
} = {}) {
  if (!harness || typeof harness.createSession !== 'function' || typeof harness.ask !== 'function') {
    throw new TypeError('GroupBrain generator requires a Harness client');
  }
  const reuseSessions = typeof channel === 'string' && channel.length > 0
    && typeof botId === 'string' && botId.length > 0;
  const sessions = reuseSessions
    ? registry ?? (dshHome ? getGroupBrainSessionRegistry({ dshHome, logger }) : null)
    : null;
  const canReuseSession = reuseSessions && Boolean(sessions);

  async function renamePersistentSession(sessionId, groupName) {
    if (typeof harness.renameSession !== 'function') return;
    await harness.renameSession(sessionId, persistentGroupSessionTitle(groupName)).catch((error) => {
      logger.warn?.('[dsh-im] group brain session rename failed:', error?.message ?? error);
    });
  }

  async function generatePersistent({ prompt, meta, chatId, images }) {
    const groupName = meta?.groupName;
    const key = groupBrainSessionKey(channel, botId, chatId);
    const existing = await sessions.get(key).catch(() => null);
    let sessionId = existing?.sessionId ?? null;
    let needsRecord = false;
    if (!sessionId) {
      sessionId = await harness.createSession();
      needsRecord = true;
      await renamePersistentSession(sessionId, groupName);
    }
    try {
      return await askSession(harness, sessionId, prompt, timeoutMs, images);
    } catch (error) {
      if (!isMissingSessionError(error)) throw error;
      logger.warn?.('[dsh-im] group brain session is gone, recreating:', error?.message ?? error);
      await sessions.delete(key).catch(() => {});
      sessionId = await harness.createSession();
      needsRecord = true;
      await renamePersistentSession(sessionId, groupName);
      return askSession(harness, sessionId, prompt, timeoutMs, images);
    } finally {
      if (needsRecord) {
        await sessions.set(key, {
          sessionId,
          channel,
          botId,
          chatId,
          title: persistentGroupSessionTitle(groupName),
        }).catch((error) => {
          logger.warn?.('[dsh-im] group brain session registry write failed:', error?.message ?? error);
        });
      }
    }
  }

  async function generateEphemeral({ kind, prompt, meta, images }) {
    const sessionId = await harness.createSession();
    try {
      if (typeof harness.renameSession === 'function') {
        await harness.renameSession(sessionId, sessionTitle(kind, meta?.groupName)).catch((error) => {
          logger.warn?.('[dsh-im] group brain session rename failed:', error?.message ?? error);
        });
      }
      return await askSession(harness, sessionId, prompt, timeoutMs, images);
    } finally {
      if (typeof harness.archiveWorkspaceSession === 'function') {
        await harness.archiveWorkspaceSession(sessionId, { timeoutMs: 15_000 }).catch((error) => {
          logger.warn?.('[dsh-im] group brain session archive failed:', error?.message ?? error);
        });
      }
    }
  }

  return async function generate({ kind, prompt, meta = {}, images = [] } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('group brain prompt is required');
    const chatId = typeof meta?.chatId === 'string' ? meta.chatId : '';
    if (canReuseSession && kind !== 'consolidate' && chatId) {
      return generatePersistent({ prompt, meta, chatId, images });
    }
    return generateEphemeral({ kind, prompt, meta, images });
  };
}

/**
 * 创建一个渠道适配层使用的群聊大脑，并登记到注册表。
 *
 * @param {object} options
 * @param {string} options.channel
 * @param {string} options.botId
 * @param {string} options.dshHome
 * @param {object} options.harness
 * @param {(request: {chatId: string, text: string, groupName?: string, meta?: object}) => Promise<any>} options.send
 * @param {() => (object|null|Promise<object|null>)} [options.resolvePersona]
 * @param {object} [options.logger]
 * @param {object} [options.timerFns] - 测试注入。
 */
export function createHostGroupBrain({
  channel,
  botId,
  dshHome,
  harness,
  send,
  resolvePersona = null,
  logger = console,
  timerFns,
}) {
  if (typeof channel !== 'string' || !channel) throw new TypeError('group brain channel is required');
  if (typeof botId !== 'string' || !botId) throw new TypeError('group brain botId is required');
  if (typeof send !== 'function') throw new TypeError('group brain send function is required');
  const registry = dshHome ? getGroupBrainSessionRegistry({ dshHome, logger }) : null;
  const generate = createHarnessGroupBrainGenerator({
    harness,
    logger,
    channel,
    botId,
    dshHome,
    registry,
  });
  // 同一个群已有统一会话时，自动接话不再重复注入人设/记忆/画像（只补最近对话）。
  const sessionExists = registry
    ? async (chatId) => Boolean(await registry.get(groupBrainSessionKey(channel, botId, chatId)))
    : null;
  const brain = new GroupBrain({
    channel,
    botId,
    dshHome,
    generate,
    send,
    resolvePersona,
    sessionExists,
    logger,
    ...(timerFns ? { timerFns } : {}),
  });
  registerHostGroupBrain(brain);
  return brain;
}

/** 登记 brain：同一 channel+botId 只保留最新实例。 */
export function registerHostGroupBrain(brain) {
  if (!brain || typeof brain.channel !== 'string' || typeof brain.botId !== 'string') {
    throw new TypeError('invalid group brain instance');
  }
  brains.set(brainKey(brain.channel, brain.botId), brain);
  return brain;
}

/** 注销（机器人被移除时调用），并释放定时器。 */
export function disposeHostGroupBrain(channel, botId) {
  const key = brainKey(channel, botId);
  const brain = brains.get(key);
  if (!brain) return false;
  brains.delete(key);
  try {
    brain.dispose?.();
  } catch {
    // 清理失败不影响注销。
  }
  return true;
}

/** 当前进程内已创建的 brain 列表。 */
export function listHostGroupBrains() {
  return [...brains.values()];
}

/** 配置变更后让所有 brain 重新读取设置。 */
export async function reloadHostGroupBrains() {
  await Promise.all(listHostGroupBrains().map((brain) => brain.reloadSettings()));
}

/** 读取全局群聊大脑设置（供 RPC get 使用）。 */
export function getHostGroupBrainSettingsStore(config) {
  return getGroupBrainSettingsStore(config);
}

/** 进程退出/测试清理。 */
export function disposeAllHostGroupBrains() {
  for (const brain of brains.values()) {
    try {
      brain.dispose?.();
    } catch {
      // 忽略。
    }
  }
  brains.clear();
}
