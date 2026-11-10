// 群聊大脑的 Host 侧适配：模型生成、运行时注册表与设置热更新。
//
// `GroupBrain` 本身不依赖 Harness 的具体形态，只要求 generate/send 两个回调；
// 本文件负责把「独立的一次性 DSH 会话」包装成 generate，并把各渠道创建出来的
// brain 实例登记到进程内注册表，供设置 RPC 统一读取状态/热更新配置。
//
// 一次性会话：群聊大脑的每次生成（自动接话、30 天记忆整理）都自带完整材料，
// 不需要沿用历史上下文；因此创建一个临时 Session、问完即归档，避免污染用户
// 的会话列表，也避免反复累积无关上下文。

import { GroupBrain } from '../../src/channels/shared/group-brain/group-brain.mjs';
import { getGroupBrainSettingsStore } from '../../src/channels/shared/group-brain/group-brain-config.mjs';

const brains = new Map();

function brainKey(channel, botId) {
  return `${channel}\u0000${botId}`;
}

function sessionTitle(kind, groupName) {
  const label = kind === 'consolidate' ? '记忆整理' : kind === 'ambient' ? '群聊接话' : '群聊';
  const name = typeof groupName === 'string' ? groupName.trim().slice(0, 40) : '';
  return `${label}${name ? ` · ${name}` : ''}`.slice(0, 80);
}

/**
 * 用 Harness 的一次性 Session 实现 generate：
 * 创建 → （尽力）重命名 → ask → 归档。
 *
 * @param {object} options
 * @param {object} options.harness - HarnessClient（需提供 createSession/ask；
 *   renameSession/archiveWorkspaceSession 为可选能力）。
 * @param {object} [options.logger]
 * @param {number} [options.timeoutMs]
 * @returns {(request: {kind: string, prompt: string, meta?: object}) => Promise<string>}
 */
export function createHarnessGroupBrainGenerator({
  harness,
  logger = console,
  timeoutMs = 180_000,
} = {}) {
  if (!harness || typeof harness.createSession !== 'function' || typeof harness.ask !== 'function') {
    throw new TypeError('GroupBrain generator requires a Harness client');
  }
  return async function generate({ kind, prompt, meta = {} } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('group brain prompt is required');
    const sessionId = await harness.createSession();
    try {
      if (typeof harness.renameSession === 'function') {
        await harness.renameSession(sessionId, sessionTitle(kind, meta.groupName)).catch((error) => {
          logger.warn?.('[dsh-im] group brain session rename failed:', error?.message ?? error);
        });
      }
      return await harness.ask(sessionId, prompt, {
        timeoutMs,
        progressMode: 'latest',
        finalAnswerOnly: true,
      });
    } finally {
      if (typeof harness.archiveWorkspaceSession === 'function') {
        await harness.archiveWorkspaceSession(sessionId, { timeoutMs: 15_000 }).catch((error) => {
          logger.warn?.('[dsh-im] group brain session archive failed:', error?.message ?? error);
        });
      }
    }
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
  const generate = createHarnessGroupBrainGenerator({ harness, logger });
  const brain = new GroupBrain({
    channel,
    botId,
    dshHome,
    generate,
    send,
    resolvePersona,
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
