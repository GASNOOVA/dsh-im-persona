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

import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

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

const DAEMON_START_TIMEOUT_MS = 30_000;
const DAEMON_POLL_MS = 500;
const DAEMON_ACCOUNT_TIMEOUT_MS = 30_000;
const DAEMON_ACCOUNT_RECOVERY_TIMEOUT_MS = 5_000;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isLoopbackDaemonUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  } catch {
    return false;
  }
}

/**
 * 从 tokenPath（<daemonDir>/aw-data/api-token）推导 agent-wechat 安装目录，
 * 供 DSH 重启后自动拉起 daemon 使用。推导失败时返回 null（不自动启动）。
 */
export function resolveAgentWechatDaemonDir(settings = {}) {
  const explicit = typeof settings?.daemonDir === 'string' ? settings.daemonDir.trim() : '';
  if (explicit) return resolve(explicit);
  const tokenPath = typeof settings?.tokenPath === 'string' ? settings.tokenPath.trim() : '';
  if (!tokenPath) return null;
  const tokenDir = dirname(resolve(tokenPath));
  return basename(tokenDir) === 'aw-data' ? dirname(tokenDir) : null;
}

function spawnAgentWechatDaemon({ daemonDir, daemonUrl, logger = console }) {
  const bin = join(daemonDir, 'node_modules', '.bin', 'wx');
  const url = new URL(daemonUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const listen = `${url.hostname}:${port}`;
  let stdio = 'ignore';
  try {
    const logFd = openSync(join(daemonDir, 'daemon.log'), 'a');
    stdio = ['ignore', logFd, logFd];
  } catch {
    stdio = 'ignore';
  }
  const child = spawn(bin, ['--data-dir', join(daemonDir, 'aw-data'), 'serve', '--listen', listen], {
    cwd: daemonDir,
    detached: true,
    stdio,
    env: {
      ...process.env,
      HOME: join(daemonDir, 'home'),
      XDG_RUNTIME_DIR: join(daemonDir, 'run'),
      XDG_CONFIG_HOME: join(daemonDir, 'home', '.config'),
      XDG_DATA_HOME: join(daemonDir, 'home', '.local', 'share'),
      XDG_CACHE_HOME: join(daemonDir, 'home', '.cache'),
      TMPDIR: join(daemonDir, 'tmp'),
    },
  });
  child.on?.('error', (error) => logger.warn?.(`[wechat-personal] unable to start agent-wechat daemon: ${error?.message ?? error}`));
  child.unref?.();
  logger.info?.(`[wechat-personal] started agent-wechat daemon from ${daemonDir} on ${listen}`);
  return child;
}

const DAEMON_PID_FILENAME = 'daemon.pid';

async function readDaemonPidFile({ daemonDir } = {}) {
  try {
    const document = JSON.parse(await readFile(join(daemonDir, DAEMON_PID_FILENAME), 'utf8'));
    const pid = Number(document?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      daemonUrl: typeof document.daemonUrl === 'string' ? document.daemonUrl : '',
      startedAt: typeof document.startedAt === 'string' ? document.startedAt : null,
    };
  } catch {
    return null;
  }
}

async function writeDaemonPidFile({ daemonDir, pid, daemonUrl } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(daemonDir, DAEMON_PID_FILENAME),
    `${JSON.stringify({ pid, daemonUrl, startedAt: new Date().toISOString(), owner: 'dsh-im-persona' })}\n`,
    { mode: 0o600 },
  );
}

async function removeDaemonPidFile({ daemonDir, pid } = {}) {
  try {
    const current = await readDaemonPidFile({ daemonDir });
    if (pid && current && current.pid !== pid) return;
    await unlink(join(daemonDir, DAEMON_PID_FILENAME));
  } catch {
    // 文件不存在或已被清理都视为成功。
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDaemonProcess({ pid, logger = console, waitMs = 5_000, pollMs = 200 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!isProcessAlive(pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(pollMs);
  }
  try {
    process.kill(pid, 'SIGKILL');
    logger.warn?.(`[wechat-personal] daemon pid ${pid} did not exit after SIGTERM; sent SIGKILL`);
  } catch {
    // 进程可能刚好退出。
  }
  return true;
}

function sameDaemonUrl(left, right) {
  try {
    return new URL(left).href.replace(/\/$/u, '') === new URL(right).href.replace(/\/$/u, '');
  } catch {
    return false;
  }
}

/**
 * 确保本地 agent-wechat daemon 可用：健康检查失败且配置指向本机时，
 * 尝试以 detached 子进程启动它并等待健康检查通过（DSH 重启后的自愈）。
 */
export async function ensureAgentWechatDaemon({
  settings = {},
  client = null,
  logger = console,
  spawnDaemon = spawnAgentWechatDaemon,
  pathExists = existsSync,
  readPid = readDaemonPidFile,
  writePid = writeDaemonPidFile,
  isAlive = isProcessAlive,
  waitMs = DAEMON_START_TIMEOUT_MS,
  pollMs = DAEMON_POLL_MS,
  sleepImpl = sleep,
} = {}) {
  const healthOk = async () => {
    try {
      await client?.health?.();
      return true;
    } catch {
      return false;
    }
  };
  const daemonDir = resolveAgentWechatDaemonDir(settings);
  if (await healthOk()) {
    // 健康但可能仍是「上一次插件生命周期」遗留的 daemon：若 pid 文件与配置匹配，
    // 就认领它，使插件关闭时能把它一起停掉（插件与 daemon 绑定生命周期）。
    const recorded = await readPid({ daemonDir });
    const owned = Boolean(recorded && recorded.pid && isAlive(recorded.pid)
      && sameDaemonUrl(recorded.daemonUrl, settings?.daemonUrl));
    return { ok: true, started: false, owned, pid: owned ? recorded.pid : null, daemonDir: daemonDir ?? null };
  }
  if (!isLoopbackDaemonUrl(settings?.daemonUrl)) return { ok: false, started: false, reason: 'remote-daemon' };
  if (!daemonDir || !pathExists(join(daemonDir, 'node_modules', '.bin', 'wx'))) {
    return { ok: false, started: false, reason: 'daemon-dir-unavailable' };
  }
  let child = null;
  try {
    child = spawnDaemon({ daemonDir, daemonUrl: settings.daemonUrl, logger });
  } catch (error) {
    return { ok: false, started: false, reason: 'daemon-start-failed', error: error?.message ?? String(error) };
  }
  const pid = Number(child?.pid);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      await writePid({ daemonDir, pid, daemonUrl: settings.daemonUrl });
    } catch (error) {
      logger.warn?.(`[wechat-personal] unable to record the daemon pid: ${error?.message ?? error}`);
    }
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleepImpl(pollMs);
    if (await healthOk()) {
      return { ok: true, started: true, owned: Number.isInteger(pid) && pid > 0, pid: Number.isInteger(pid) && pid > 0 ? pid : null, daemonDir: daemonDir ?? null };
    }
  }
  return { ok: false, started: true, reason: 'daemon-timeout' };
}

async function waitForDaemonAccount({
  client,
  accountId,
  logger = console,
  waitMs = DAEMON_ACCOUNT_TIMEOUT_MS,
  pollMs = DAEMON_POLL_MS,
  sleepImpl = sleep,
} = {}) {
  const deadline = Date.now() + waitMs;
  let lastError = null;
  while (true) {
    try {
      const account = await client.getAccount(accountId);
      if (account?.authenticated) return account;
      lastError = new Error('微信个人号尚未登录，请先在 agent-wechat 中扫码登录');
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    logger.debug?.('[wechat-personal] waiting for the daemon account to recover…');
    await sleepImpl(pollMs);
  }
  throw lastError ?? new Error('微信个人号账号不可用');
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
  let ownedDaemon = null;
  let queue = Promise.resolve();

  const serialize = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  /**
   * 停止由本插件拉起（或认领）的 agent-wechat daemon。
   * 插件与 daemon 绑定生命周期：启动时按需拉起，禁用插件/热重载/宿主关闭时一起停止；
   * 若 daemon 是用户手动启动的（没有 pid 文件），这里不会碰它。
   */
  async function stopOwnedDaemon(reason) {
    const owned = ownedDaemon;
    ownedDaemon = null;
    if (!owned) return;
    const stopDaemon = internals.stopDaemon ?? stopDaemonProcess;
    const removePid = internals.removeDaemonPid ?? removeDaemonPidFile;
    try {
      await stopDaemon({ pid: owned.pid, logger });
      logger.info?.(`[wechat-personal] stopped owned agent-wechat daemon (pid ${owned.pid}): ${reason}`);
    } catch (error) {
      logger.warn?.(`[wechat-personal] unable to stop the owned daemon: ${error?.message ?? error}`);
    } finally {
      try {
        await removePid({ daemonDir: owned.daemonDir, pid: owned.pid });
      } catch {
        // pid 文件清理失败不影响后续启动。
      }
    }
  }

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
    const ensureDaemon = internals.ensureDaemon ?? ensureAgentWechatDaemon;
    const ensured = await ensureDaemon({
      settings: { ...settings, daemonUrl },
      client,
      logger: channelLogger(logger),
      spawnDaemon: internals.spawnDaemon,
      pathExists: internals.pathExists,
      readPid: internals.readPid,
      writePid: internals.writePid,
      isAlive: internals.isAlive,
      waitMs: internals.daemonStartWaitMs,
      pollMs: internals.daemonStartPollMs,
    });
    if (!ensured.ok) {
      logger.warn?.(`[wechat-personal] agent-wechat daemon not reachable (${ensured.reason ?? 'unknown'}); start it manually or set tokenPath inside the daemon directory`);
    } else if (ensured.owned && ensured.pid) {
      ownedDaemon = { pid: ensured.pid, daemonDir: ensured.daemonDir, daemonUrl };
      logger.info?.(`[wechat-personal] ${ensured.started ? 'started' : 'adopted'} agent-wechat daemon (pid ${ensured.pid})`);
    }
    const waitAccount = internals.waitForAccount ?? waitForDaemonAccount;
    const account = await waitAccount({
      client,
      accountId: settings.accountId,
      logger: channelLogger(logger),
      waitMs: ensured.started
        ? (internals.daemonAccountWaitMs ?? DAEMON_ACCOUNT_TIMEOUT_MS)
        : (internals.daemonAccountRecoveryWaitMs ?? DAEMON_ACCOUNT_RECOVERY_TIMEOUT_MS),
      pollMs: internals.daemonStartPollMs,
    });
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
      mergeWindowMs: settings.ambient?.mergeWindowMs,
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
        await stopOwnedDaemon('settings-unavailable');
        return { ok: false, reason: 'settings-unavailable', error: lastError };
      }
      const personal = settings?.wechatPersonal;
      if (!personal?.enabled) {
        await closeSession();
        await stopOwnedDaemon('disabled');
        return { ok: true, running: false, reason: 'disabled' };
      }
      if (!personal.accountId) {
        await closeSession();
        await stopOwnedDaemon('incomplete');
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
    return serialize(async () => {
      await closeSession();
      await stopOwnedDaemon('dispose');
    });
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
