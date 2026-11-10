// 微信个人号运行时：把 agent-wechat daemon 与群聊大脑连接起来。
//
// 这一层只在用户显式开启「群聊大脑 → 微信个人号」后启动：
// - 从群聊大脑设置读取 daemon 地址、账号、token 路径与人设；
// - 建立 GroupBrain（channel='wechat-personal'，botId=accountId）；
// - 用 SSE 桥接群消息（@ 直通回复 / 静默自动接话 / 记忆整理）；
// - 提供 reload / status / test / personas 给设置页 RPC。
//
// 设计上不新增独立的 IM 渠道卡片：微信个人号只是群聊大脑的一种输入源，
// 因此人设、上下文增强、白名单、记忆调度都复用已有的群聊大脑配置。

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_GROUP_BRAIN_SETTINGS,
  getGroupBrainSettingsStore,
} from '../../src/channels/shared/group-brain/group-brain-config.mjs';
import { GroupBrain } from '../../src/channels/shared/group-brain/group-brain.mjs';
import { getImageInputSettingsStore } from '../../src/channels/shared/image-input-settings-store.mjs';
import { getOffPeakSettingsStore } from '../../src/channels/shared/off-peak-settings-store.mjs';
import { getPersonaLibrary } from '../../src/channels/shared/persona-library.mjs';
import { personaPresetFor } from '../../src/channels/shared/persona-presets.mjs';
import { prepareBotWorkspace } from '../../src/channels/shared/default-workspace.mjs';
import {
  AgentWechatClient,
  normalizeAgentWechatDaemonUrl,
} from '../../src/channels/wechat-personal/agent-wechat-client.mjs';
import { WechatPersonalGroupBridge } from '../../src/channels/wechat-personal/wechat-personal-brain.mjs';
import { createHarnessGroupBrainGenerator } from './group-brain-runtime.mjs';
import { getGroupBrainSessionRegistry, groupBrainSessionKey } from './group-brain-sessions.mjs';
import { harnessConnection } from './harness-connection.mjs';
import { HarnessClient } from '../../src/channels/weixin/harness-client.mjs';

const DEFAULT_PERSONA_ID = DEFAULT_GROUP_BRAIN_SETTINGS.wechatPersonal.personaId;
const CONNECT_TIMEOUT_MS = 20_000;

// HMR 重载会重新实例化本模块，但同一宿主进程里的旧桥接实例可能还没被回收。
// 用 globalThis 上的共享注册表记录活跃桥接，新实例启动前先停掉同一 daemon+账号的旧实例，
// 避免多个 SSE 连接同时消费同一批群消息、重复写入长期记录/重复回复。
const LIVE_BRIDGES_KEY = Symbol.for('dsh-im-persona.wechat-personal.live-bridges');
const STALE_BRIDGE_STOP_TIMEOUT_MS = 5_000;

function liveBridges() {
  if (!globalThis[LIVE_BRIDGES_KEY]) globalThis[LIVE_BRIDGES_KEY] = new Map();
  return globalThis[LIVE_BRIDGES_KEY];
}

async function stopBridgeQuietly(bridge, logger) {
  if (!bridge || typeof bridge.stop !== 'function') return;
  let timer = null;
  try {
    await Promise.race([
      bridge.stop(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, STALE_BRIDGE_STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    logger.warn?.('[wechat-personal] unable to stop a stale bridge:', error?.message ?? error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function dshHomeOf(config = {}) {
  return resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}

// Host 被打包进 DSH 时，顶层 config 可能只有各渠道的键（例如 startup 测试的
// { weixin, qq }），此时把渠道配置里的 dshHome 提上来，避免回退到真实
// DSH_HOME 而意外读取用户已启用的微信个人号配置。
function normalizeRuntimeConfig(config = {}, internals = {}) {
  if (typeof internals.dshHome === 'string' && internals.dshHome) {
    return { ...config, dshHome: internals.dshHome };
  }
  if (typeof config?.dshHome === 'string' && config.dshHome) return config;
  const nested = [config?.weixin?.dshHome, config?.qq?.dshHome]
    .find((value) => typeof value === 'string' && value.length > 0);
  return nested ? { ...config, dshHome: nested } : config;
}

function tokenPathOf(config, settings) {
  if (typeof settings?.tokenPath === 'string' && settings.tokenPath.trim()) return resolve(settings.tokenPath.trim());
  return join(dshHomeOf(config), 'integrations', 'dsh-im', 'wechat-personal', 'api-token');
}

function cursorPathOf(config, accountId) {
  return join(dshHomeOf(config), 'integrations', 'dsh-im', 'wechat-personal', `${accountId}-cursor.json`);
}

function channelLogger(logger, name = '[dsh-im:wechat-personal]') {
  return {
    error: (...args) => logger.error?.(name, ...args),
    warn: (...args) => logger.warn?.(name, ...args),
    info: (...args) => logger.info?.(name, ...args),
    debug: (...args) => logger.debug?.(name, ...args),
  };
}

/** 解析人设 id：builtin 优先，其次是人设库（含 config personaFile）。 */
export async function resolveWechatPersonalPersona(config, personaId) {
  const id = typeof personaId === 'string' && personaId.trim() ? personaId.trim() : DEFAULT_PERSONA_ID;
  const preset = personaPresetFor(id);
  if (preset) return { enabled: true, name: preset.name, text: preset.text };
  try {
    const library = getPersonaLibrary({
      dshHome: config?.dshHome,
      ...(config?.personaFile ? { personaFile: config.personaFile } : {}),
    });
    await library.load();
    const entry = await library.get(id);
    if (entry && typeof entry.text === 'string' && entry.text.trim()) {
      return { enabled: true, name: entry.name, text: entry.text };
    }
  } catch {
    // 人设不存在/库损坏都 fail-soft：用默认群聊版大肥鱼。
  }
  const fallback = personaPresetFor(DEFAULT_PERSONA_ID);
  return fallback ? { enabled: true, name: fallback.name, text: fallback.text } : null;
}

/** 供设置页下拉使用：builtin + 导入的人设（不含重复 id）。 */
export async function listWechatPersonalPersonaChoices(config) {
  const choices = [];
  const seen = new Set();
  for (const preset of ['dafeiyu', 'dafeiyu-group']) {
    const value = personaPresetFor(preset);
    if (!value || seen.has(value.id)) continue;
    seen.add(value.id);
    choices.push({ id: value.id, name: value.name, description: value.description ?? '', source: 'builtin' });
  }
  try {
    const library = getPersonaLibrary({
      dshHome: config?.dshHome,
      ...(config?.personaFile ? { personaFile: config.personaFile } : {}),
    });
    await library.load();
    for (const entry of library.list()) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      choices.push({ id: entry.id, name: entry.name, description: entry.description ?? '', source: entry.source });
    }
  } catch {
    // 人设库不可用时只列 builtin。
  }
  return choices;
}

async function readToken(path) {
  const token = (await readFile(path, 'utf8')).trim();
  if (!token) throw new Error('微信个人号的 daemon token 文件为空');
  return token;
}

/**
 * 创建微信个人号管理器（单例由 installWechatPersonalRuntime 持有）。
 * 所有外部依赖都可以通过 internals 注入，便于单元测试。
 */
export function createWechatPersonalManager({ ctx = null, config: rawConfig = {}, internals = {} }) {
  const config = normalizeRuntimeConfig(rawConfig, internals);
  const logger = internals.logger
    ?? (typeof ctx?.logger === 'function' ? ctx.logger('dsh-im:wechat-personal') : (ctx?.logger ?? console));
  const settingsStore = internals.settingsStore ?? getGroupBrainSettingsStore(config);
  const Client = internals.Client ?? AgentWechatClient;
  const Bridge = internals.Bridge ?? WechatPersonalGroupBridge;
  const Brain = internals.Brain ?? GroupBrain;

  let session = null;
  let lastError = null;
  let startedAt = null;
  let queue = Promise.resolve();

  const serialize = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  async function closeSession() {
    const current = session;
    session = null;
    if (!current) return;
    try { await current.bridge?.stop?.(); }
    catch (error) { logger.warn?.('[wechat-personal] bridge stop failed:', error?.message ?? error); }
    try { await current.brain?.dispose?.(); }
    catch (error) { logger.warn?.('[wechat-personal] brain dispose failed:', error?.message ?? error); }
    try { await current.client?.close?.(); }
    catch { /* 客户端没有常驻连接，close 失败不影响后续重连。 */ }
    if (current.registryKey) {
      const registry = liveBridges();
      if (registry.get(current.registryKey) === current.bridge) registry.delete(current.registryKey);
    }
  }

  async function startSession(settings) {
    if (!settings?.accountId) throw new Error('未配置微信个人号账号 ID');
    if (!settings?.daemonUrl) throw new Error('未配置 agent-wechat daemon 地址');
    const daemonUrl = normalizeAgentWechatDaemonUrl(settings.daemonUrl);
    const token = await readToken(tokenPathOf(config, settings));
    const client = internals.client ?? new Client({
      baseUrl: daemonUrl,
      token,
      accountId: settings.accountId,
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    const account = await client.getAccount(settings.accountId);
    if (!account?.authenticated) throw new Error('微信个人号尚未登录，请先在 agent-wechat 中扫码登录');
    const ownUserId = typeof account.ownUsername === 'string' ? account.ownUsername : '';
    if (!ownUserId) throw new Error('微信个人号账号缺少 ownUsername');
    const offPeakSettings = internals.offPeakSettings ?? getOffPeakSettingsStore({ dshHome: config.dshHome });
    await offPeakSettings.get().catch(() => {});
    const sessionRegistry = internals.sessionRegistry
      ?? (internals.generate ? null : getGroupBrainSessionRegistry({ dshHome: config.dshHome, logger: channelLogger(logger) }));
    const sessionExists = internals.sessionExists
      ?? (sessionRegistry
        ? async (chatId) => Boolean(await sessionRegistry.get(groupBrainSessionKey('wechat-personal', settings.accountId, chatId)))
        : null);
    const rawGenerate = internals.generate ?? createHarnessGroupBrainGenerator({
      harness: await createHarness(),
      logger,
      timeoutMs: internals.timeoutMs ?? 180_000,
      // 同一群的所有回复复用同一个 DSH 会话（统一群聊上下文）。
      channel: 'wechat-personal',
      botId: settings.accountId,
      dshHome: config.dshHome,
      registry: sessionRegistry,
    });
    const generate = async (request) => {
      let blocked = false;
      try { blocked = offPeakSettings.shouldBlockInbound?.(new Date()) === true; } catch { blocked = false; }
      if (blocked) return '[SKIP]';
      return rawGenerate(request);
    };
    const resolvePersona = async () => resolveWechatPersonalPersona(config, settings.personaId);
    // 闲时启用且处于 DeepSeek 高峰时，桥接层直接回固定提示，不进入模型。
    const isSleeping = async () => {
      try { return offPeakSettings.shouldBlockInbound?.(new Date()) === true; } catch { return false; }
    };
    let bridgeRef = null;
    const brain = internals.brain ?? new Brain({
      channel: 'wechat-personal',
      botId: settings.accountId,
      dshHome: config.dshHome,
      generate,
      send: async (payload) => {
        if (!bridgeRef) return false;
        return bridgeRef.sendAmbient(payload);
      },
      resolvePersona,
      sessionExists,
      logger: channelLogger(logger),
    });
    await brain.load?.();
    await brain.start?.();
    const bridge = internals.bridge ?? new Bridge({
      client,
      brain,
      generate,
      resolvePersona,
      sessionExists,
      isSleeping,
      accountId: settings.accountId,
      ownUserId,
      statePath: cursorPathOf(config, settings.accountId),
      logger: channelLogger(logger),
    });
    bridgeRef = bridge;
    const registryKey = `${daemonUrl}\u0000${settings.accountId}`;
    const registry = liveBridges();
    const stale = registry.get(registryKey);
    if (stale && stale !== bridge) {
      logger.warn?.('[wechat-personal] stopping a stale bridge from an earlier reload');
      await stopBridgeQuietly(stale, logger);
    }
    registry.set(registryKey, bridge);
    session = { client, bridge, brain, account, settings, ownUserId, registryKey };
    try {
      await bridge.start();
    } catch (error) {
      await closeSession();
      throw error;
    }
    startedAt = new Date().toISOString();
    logger.info?.(`[wechat-personal] bridge online: ${settings.accountId} (${ownUserId})`);
    return session;
  }

  async function createHarness() {
    if (internals.harness) return internals.harness;
    const connection = harnessConnection(ctx, config);
    const { defaultWorkspace, ungroupedWorkspace } = await prepareBotWorkspace(config);
    return new HarnessClient({
      ...connection,
      workspace: defaultWorkspace,
      ungroupedWorkspace,
      autostart: false,
      dshBin: config.dshBin ?? 'dsh',
      imageInputPolicy: () => getImageInputSettingsStore(config).get(),
    });
  }

  async function reload() {
    return serialize(async () => {
      lastError = null;
      let settings;
      try {
        settings = await settingsStore.get();
      } catch (error) {
        lastError = `读取群聊大脑设置失败：${error?.message ?? error}`;
        await closeSession();
        return { ok: false, reason: 'settings-unavailable', error: lastError };
      }
      const personal = settings?.wechatPersonal;
      if (!personal?.enabled) {
        await closeSession();
        return { ok: true, running: false, reason: 'disabled' };
      }
      if (!personal.accountId) {
        await closeSession();
        lastError = '未配置微信个人号账号 ID';
        return { ok: false, reason: 'incomplete', error: lastError };
      }
      await closeSession();
      try {
        await startSession(personal);
        return { ok: true, running: true };
      } catch (error) {
        lastError = error?.message ?? String(error);
        await closeSession();
        logger.warn?.('[wechat-personal] start failed:', lastError);
        return { ok: false, reason: 'start-failed', error: lastError };
      }
    });
  }

  async function status() {
    let settings = null;
    try { settings = await settingsStore.get(); } catch {}
    const current = session;
    let runtime = null;
    if (current?.bridge) {
      try { runtime = await current.bridge.status(); } catch (error) { runtime = { running: false, lastError: error?.message ?? String(error) }; }
    }
    return {
      configured: settings?.wechatPersonal ?? DEFAULT_GROUP_BRAIN_SETTINGS.wechatPersonal,
      running: Boolean(current),
      startedAt,
      lastError: lastError ?? runtime?.lastError ?? null,
      account: current?.account
        ? {
          id: current.settings?.accountId ?? current.account.id ?? '',
          ownUserId: current.ownUserId ?? '',
          authenticated: current.account.authenticated === true,
          connection: current.account.connection ?? null,
          incomingTransport: current.account.incomingTransport ?? null,
          contactSyncReady: current.account.contactSyncReady === true,
        }
        : null,
      runtime,
      persona: current?.settings?.personaId ?? settings?.wechatPersonal?.personaId ?? DEFAULT_PERSONA_ID,
    };
  }

  async function test() {
    let settings;
    try { settings = await settingsStore.get(); } catch (error) { return { ok: false, error: `读取群聊大脑设置失败：${error?.message ?? error}` }; }
    const personal = settings?.wechatPersonal;
    if (!personal?.accountId) return { ok: false, error: '未配置微信个人号账号 ID' };
    try {
      const daemonUrl = normalizeAgentWechatDaemonUrl(personal.daemonUrl);
      const token = await readToken(tokenPathOf(config, personal));
      const client = new Client({ baseUrl: daemonUrl, token, accountId: personal.accountId, timeoutMs: CONNECT_TIMEOUT_MS });
      const health = await client.health();
      const account = await client.getAccount(personal.accountId);
      let threads = 0;
      let groups = [];
      try {
        const list = await client.listThreads({ limit: 50 });
        threads = Array.isArray(list) ? list.length : 0;
        groups = (Array.isArray(list) ? list : [])
          .filter((thread) => thread?.kind === 'group')
          .slice(0, 10)
          .map((thread) => ({
            chatId: String(thread.id ?? ''),
            name: String(thread.displayName ?? ''),
            memberHint: Array.isArray(thread.avatarMembers) ? thread.avatarMembers.length : null,
          }));
      } catch {
        // 列表失败不影响登录态测试结论。
      }
      return {
        ok: true,
        daemon: { baseUrl: daemonUrl, health },
        account: {
          id: personal.accountId,
          authenticated: account?.authenticated === true,
          connection: account?.connection ?? null,
          ownUsername: account?.ownUsername ?? '',
          incomingTransport: account?.incomingTransport ?? null,
          contactSyncReady: account?.contactSyncReady === true,
        },
        threads,
        groups,
      };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  async function listPersonas() {
    return listWechatPersonalPersonaChoices(config);
  }

  async function close() {
    return serialize(async () => { await closeSession(); });
  }

  return { reload, status, test, listPersonas, close, config };
}

let activeManager = null;

export function getWechatPersonalManager() {
  return activeManager;
}

/**
 * 安装微信个人号运行时：读取配置，若已开启则尝试连接；返回管理器。
 */
export async function installWechatPersonalRuntime(ctx, { config = {}, internals = {} } = {}) {
  const manager = internals.manager ?? createWechatPersonalManager({ ctx, config, internals });
  activeManager = manager;
  await manager.reload().catch((error) => {
    if (typeof ctx?.logger === 'function') ctx.logger('dsh-im').warn?.('[wechat-personal] initial reload failed:', error?.message ?? error);
    else ctx?.logger?.warn?.('[wechat-personal] initial reload failed:', error?.message ?? error);
  });
  if (typeof ctx?.on === 'function') {
    try {
      ctx.on('dispose', () => {
        void manager.close();
        if (activeManager === manager) activeManager = null;
      });
    } catch {
      // 某些 Host 版本不暴露 dispose 事件；进程退出时由运行环境清理。
    }
  }
  return manager;
}
