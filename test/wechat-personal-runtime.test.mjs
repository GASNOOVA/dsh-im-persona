import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createWechatPersonalManager,
  ensureAgentWechatDaemon,
  getWechatPersonalManager,
  installWechatPersonalRuntime,
  listWechatPersonalPersonaChoices,
  resolveAgentWechatDaemonDir,
  resolveWechatPersonalPersona,
} from '../plugin-src/host/wechat-personal-runtime.mjs';

function makeHome() {
  return mkdtemp(join(tmpdir(), 'wp-runtime-'));
}

function fakeSettingsStore(initial) {
  let value = initial;
  return {
    get: async () => value,
    set: async (next) => { value = next; return next; },
    current: () => value,
  };
}

function mocks() {
  const state = {
    clients: [],
    bridges: [],
    brains: [],
    stopped: 0,
  };
  class FakeClient {
    constructor(options) {
      this.options = options;
      state.clients.push(this);
    }
    async health() { return { status: 'ok' }; }
    async getAccount() {
      return {
        id: 'xiaohao',
        authenticated: true,
        ownUsername: 'wxid_me',
        connection: 'online',
        incomingTransport: 'native_push',
        contactSyncReady: true,
      };
    }
    async listThreads() {
      return [
        { id: '19129875381@chatroom', displayName: '👫', kind: 'group', avatarMembers: [{ id: 'a' }, { id: 'b' }] },
        { id: 'wxid_friend', displayName: 'Zach', kind: 'direct' },
      ];
    }
    async close() { this.closed = true; }
  }
  class FakeBrain {
    constructor(options) {
      this.options = options;
      state.brains.push(this);
    }
    async load() { this.loaded = true; }
    async start() { this.started = true; }
    async dispose() { this.disposed = true; state.stopped += 1; }
    status() { return { groups: [] }; }
  }
  class FakeBridge {
    constructor(options) {
      this.options = options;
      state.bridges.push(this);
    }
    async start() { this.running = true; }
    async stop() { this.running = false; state.stopped += 1; }
    async status() { return { running: Boolean(this.running), groups: [] }; }
    async sendAmbient() { return true; }
  }
  return { state, internals: { Client: FakeClient, Brain: FakeBrain, Bridge: FakeBridge } };
}

const BASE_SETTINGS = {
  enabled: true,
  maxMembers: 5,
  allowedGroups: [],
  ambient: { enabled: true },
  memory: { consolidateIntervalDays: 30 },
  profiles: { enabled: true },
  wechatPersonal: {
    enabled: true,
    daemonUrl: 'http://127.0.0.1:16174',
    tokenPath: '',
    accountId: 'xiaohao',
    personaId: 'dafeiyu-group',
  },
};

test('wechat personal manager stays idle when the bridge is disabled', async () => {
  const { internals } = mocks();
  const home = await makeHome();
  try {
    const manager = createWechatPersonalManager({
      config: { dshHome: home },
      internals: {
        ...internals,
        settingsStore: fakeSettingsStore({ ...BASE_SETTINGS, wechatPersonal: { ...BASE_SETTINGS.wechatPersonal, enabled: false } }),
      },
    });
    const result = await manager.reload();
    assert.equal(result.ok, true);
    assert.equal(result.running, false);
    const status = await manager.status();
    assert.equal(status.running, false);
    assert.equal(status.configured.enabled, false);
    await manager.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('wechat personal manager reports an incomplete configuration', async () => {
  const { internals } = mocks();
  const home = await makeHome();
  try {
    const manager = createWechatPersonalManager({
      config: { dshHome: home },
      internals: {
        ...internals,
        settingsStore: fakeSettingsStore({ ...BASE_SETTINGS, wechatPersonal: { ...BASE_SETTINGS.wechatPersonal, accountId: '' } }),
      },
    });
    const result = await manager.reload();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'incomplete');
    assert.match(result.error, /账号 ID/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('wechat personal manager starts a session from the token file', async () => {
  const { state, internals } = mocks();
  const home = await makeHome();
  const tokenPath = join(home, 'api-token');
  await writeFile(tokenPath, 'secret-token\n', 'utf8');
  try {
    const settingsStore = fakeSettingsStore({ ...BASE_SETTINGS, wechatPersonal: { ...BASE_SETTINGS.wechatPersonal, tokenPath } });
    const manager = createWechatPersonalManager({
      config: { dshHome: home },
      internals: {
        ...internals,
        settingsStore,
        generate: async () => '你好',
        offPeakSettings: { get: async () => ({}), shouldBlockInbound: () => false },
      },
    });
    const result = await manager.reload();
    assert.equal(result.ok, true);
    assert.equal(result.running, true);
    assert.equal(state.clients.length, 1);
    assert.equal(state.clients[0].options.token, 'secret-token');
    assert.equal(state.brains.length, 1);
    assert.equal(state.brains[0].options.channel, 'wechat-personal');
    assert.equal(state.brains[0].options.botId, 'xiaohao');
    assert.equal(state.bridges.length, 1);
    assert.equal(state.bridges[0].options.ownUserId, 'wxid_me');
    assert.equal(state.brains[0].loaded, true);
    assert.equal(state.brains[0].started, true);
    assert.equal(state.bridges[0].running, true);

    const status = await manager.status();
    assert.equal(status.running, true);
    assert.equal(status.account.ownUserId, 'wxid_me');
    assert.equal(status.persona, 'dafeiyu-group');

    const tested = await manager.test();
    assert.equal(tested.ok, true);
    assert.equal(tested.daemon.health.status, 'ok');
    assert.equal(tested.threads, 2);
    assert.equal(tested.groups.length, 1);
    assert.equal(tested.groups[0].chatId, '19129875381@chatroom');

    const personas = await manager.listPersonas();
    assert.ok(personas.some((persona) => persona.id === 'dafeiyu-group'));

    await manager.close();
    assert.equal(status.running && (await manager.status()).running, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('wechat personal persona resolution prefers the dedicated group builtin', async () => {
  const home = await makeHome();
  try {
    const persona = await resolveWechatPersonalPersona({ dshHome: home }, 'dafeiyu-group');
    assert.equal(persona.enabled, true);
    assert.equal(persona.name, '大肥鱼（群聊版）');
    assert.match(persona.text, /群友/u);
    const fallback = await resolveWechatPersonalPersona({ dshHome: home }, 'missing-persona');
    assert.equal(fallback.name, '大肥鱼（群聊版）');
    const choices = await listWechatPersonalPersonaChoices({ dshHome: home });
    assert.ok(choices.some((choice) => choice.id === 'dafeiyu-group'));
    assert.ok(choices.some((choice) => choice.id === 'dafeiyu'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('installWechatPersonalRuntime registers the active manager', async () => {
  const { internals } = mocks();
  const home = await makeHome();
  try {
    const settingsStore = fakeSettingsStore({ ...BASE_SETTINGS, wechatPersonal: { ...BASE_SETTINGS.wechatPersonal, enabled: false } });
    const installed = await installWechatPersonalRuntime(null, {
      config: { dshHome: home },
      internals: { ...internals, settingsStore },
    });
    assert.equal(getWechatPersonalManager(), installed);
    await installed.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test('resolveAgentWechatDaemonDir derives the daemon directory from the token path', () => {
  assert.equal(resolveAgentWechatDaemonDir({ tokenPath: '/opt/aw/aw-data/api-token' }), '/opt/aw');
  assert.equal(resolveAgentWechatDaemonDir({ tokenPath: '/data/tokens/api-token' }), null);
  assert.equal(resolveAgentWechatDaemonDir({ tokenPath: '' }), null);
  assert.equal(resolveAgentWechatDaemonDir({}), null);
});

test('ensureAgentWechatDaemon starts a local daemon when health is down', async () => {
  const spawned = [];
  let healthCalls = 0;
  const client = {
    async health() {
      healthCalls += 1;
      if (healthCalls < 2) throw new Error('down');
      return { status: 'ok' };
    },
  };
  const daemonDir = '/opt/aw';
  const result = await ensureAgentWechatDaemon({
    settings: { daemonUrl: 'http://127.0.0.1:16175', tokenPath: '/opt/aw/aw-data/api-token' },
    client,
    logger: { info() {}, warn() {} },
    pathExists: (path) => path === join(daemonDir, 'node_modules', '.bin', 'wx'),
    spawnDaemon: (args) => spawned.push(args),
    sleepImpl: async () => {},
    waitMs: 100,
    pollMs: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].daemonDir, daemonDir);
  assert.equal(spawned[0].daemonUrl, 'http://127.0.0.1:16175');
});

test('ensureAgentWechatDaemon does not spawn a remote daemon', async () => {
  let spawnCalls = 0;
  const result = await ensureAgentWechatDaemon({
    settings: { daemonUrl: 'http://192.168.1.9:16175', tokenPath: '/opt/aw/aw-data/api-token' },
    client: { async health() { throw new Error('down'); } },
    logger: { info() {}, warn() {} },
    pathExists: () => true,
    spawnDaemon: () => { spawnCalls += 1; },
    sleepImpl: async () => {},
    waitMs: 10,
  });
  assert.equal(result.ok, false);
  assert.equal(result.started, false);
  assert.equal(result.reason, 'remote-daemon');
  assert.equal(spawnCalls, 0);
});

test('ensureAgentWechatDaemon skips when the daemon directory cannot be derived', async () => {
  const result = await ensureAgentWechatDaemon({
    settings: { daemonUrl: 'http://127.0.0.1:16175', tokenPath: '/data/tokens/api-token' },
    client: { async health() { throw new Error('down'); } },
    logger: { info() {}, warn() {} },
    pathExists: () => true,
    spawnDaemon: () => {},
    sleepImpl: async () => {},
    waitMs: 10,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'daemon-dir-unavailable');
});

test('wechat personal manager auto-starts the daemon and waits for the account', async () => {
  const { internals } = mocks();
  const home = await makeHome();
  const daemonDir = join(home, 'agent-wechat');
  const tokenDir = join(daemonDir, 'aw-data');
  await mkdir(tokenDir, { recursive: true });
  const tokenPath = join(tokenDir, 'api-token');
  await writeFile(tokenPath, 'secret-token\n', 'utf8');
  const spawned = [];
  const accountCalls = { count: 0 };
  class DownThenUpClient {
    constructor(options) { this.options = options; }
    async health() {
      if (!this.healthChecked) { this.healthChecked = true; throw new Error('daemon down'); }
      return { status: 'ok' };
    }
    async getAccount() {
      accountCalls.count += 1;
      if (accountCalls.count === 1) throw new Error('account not ready');
      return { authenticated: true, ownUsername: 'wxid_me', connection: 'online' };
    }
    async close() {}
  }
  try {
    const manager = createWechatPersonalManager({
      config: { dshHome: home },
      internals: {
        ...internals,
        Client: DownThenUpClient,
        settingsStore: fakeSettingsStore({
          ...BASE_SETTINGS,
          wechatPersonal: {
            ...BASE_SETTINGS.wechatPersonal,
            daemonUrl: 'http://127.0.0.1:16175',
            tokenPath,
          },
        }),
        generate: async () => '你好',
        offPeakSettings: { get: async () => ({}), shouldBlockInbound: () => false },
        pathExists: (path) => path === join(daemonDir, 'node_modules', '.bin', 'wx'),
        spawnDaemon: (args) => spawned.push(args),
        daemonStartPollMs: 1,
        daemonAccountWaitMs: 2_000,
      },
    });
    const result = await manager.reload();
    assert.equal(result.ok, true);
    assert.equal(result.running, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].daemonDir, daemonDir);
    assert.ok(accountCalls.count >= 2);
    await manager.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
