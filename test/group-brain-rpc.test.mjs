import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GROUP_BRAIN_ENDPOINTS,
  createGroupBrainRpcHandler,
} from '../plugin-src/host/group-brain-rpc.mjs';
import { DEFAULT_GROUP_BRAIN_SETTINGS } from '../src/channels/shared/group-brain/group-brain-config.mjs';

function fakeStore(initial = DEFAULT_GROUP_BRAIN_SETTINGS) {
  let value = initial;
  return {
    get: async () => value,
    set: async (next) => { value = next; return next; },
    current: () => value,
  };
}

test('group brain RPC reads and saves normalized settings', async () => {
  const store = fakeStore();
  let reloads = 0;
  const handler = createGroupBrainRpcHandler({
    store,
    listBrains: () => [],
    reloadBrains: async () => { reloads += 1; },
  });
  const read = await handler(GROUP_BRAIN_ENDPOINTS.get, {});
  assert.equal(read.ok, true);
  assert.equal(read.value.enabled, true);

  const saved = await handler(GROUP_BRAIN_ENDPOINTS.set, {
    enabled: false,
    ambient: { enabled: false, silenceMs: 300_000 },
    allowedGroups: [{ channel: 'qq', botId: 'bot-1', chatId: 'group-1', groupName: '小群' }],
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.enabled, false);
  assert.equal(saved.value.ambient.enabled, false);
  assert.equal(saved.value.ambient.silenceMs, 300_000);
  assert.equal(saved.value.allowedGroups.length, 1);
  assert.equal(reloads, 1);
});

test('group brain RPC rejects unknown keys and malformed requests', async () => {
  const handler = createGroupBrainRpcHandler({
    store: fakeStore(),
    listBrains: () => [],
    reloadBrains: async () => {},
  });
  assert.equal((await handler(GROUP_BRAIN_ENDPOINTS.set, { nope: true })).ok, false);
  assert.equal((await handler(GROUP_BRAIN_ENDPOINTS.set, null)).ok, false);
  assert.equal((await handler(GROUP_BRAIN_ENDPOINTS.get, { nope: true })).ok, false);
  assert.equal((await handler('unknown.endpoint', {})).ok, false);
});

test('group brain RPC status reports registered brains', async () => {
  const handler = createGroupBrainRpcHandler({
    store: fakeStore(),
    listBrains: () => [{
      channel: 'qq',
      botId: 'bot-1',
      status: () => ({ enabled: true, groups: [{ chatId: 'group-1', nextConsolidateAt: 1 }] }),
    }],
    reloadBrains: async () => {},
  });
  const status = await handler(GROUP_BRAIN_ENDPOINTS.status, {});
  assert.equal(status.ok, true);
  assert.equal(status.value.brains.length, 1);
  assert.equal(status.value.brains[0].channel, 'qq');
  assert.equal(status.value.brains[0].botId, 'bot-1');
  assert.equal(status.value.brains[0].status.groups.length, 1);
});

test('group brain RPC consolidates a specific group or every registered brain', async () => {
  const calls = [];
  const brain = {
    channel: 'qq',
    botId: 'bot-1',
    forceConsolidate: async (chatId) => { calls.push(['force', chatId]); return { ok: true }; },
    maybeConsolidateAll: async (options) => { calls.push(['all', options]); return { consolidated: 1 }; },
  };
  const handler = createGroupBrainRpcHandler({
    store: fakeStore(),
    listBrains: () => [brain],
    reloadBrains: async () => {},
  });
  const single = await handler(GROUP_BRAIN_ENDPOINTS.consolidate, { channel: 'qq', botId: 'bot-1', chatId: 'group-1' });
  assert.equal(single.ok, true);
  assert.deepEqual(calls[0], ['force', 'group-1']);

  const all = await handler(GROUP_BRAIN_ENDPOINTS.consolidate, {});
  assert.equal(all.ok, true);
  assert.deepEqual(calls[1], ['all', { force: true }]);
});

test('group brain RPC reports a missing brain instead of throwing', async () => {
  const handler = createGroupBrainRpcHandler({
    store: fakeStore(),
    listBrains: () => [],
    reloadBrains: async () => {},
  });
  const result = await handler(GROUP_BRAIN_ENDPOINTS.consolidate, { chatId: 'group-1' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unknown-brain');
});

function fakeWechatManager() {
  const calls = { reload: 0, test: 0, personas: 0 };
  return {
    calls,
    status: async () => ({ configured: true, running: true, account: { id: 'xiaohao' } }),
    reload: async () => { calls.reload += 1; },
    test: async () => { calls.test += 1; return { ok: true, daemon: { baseUrl: 'http://127.0.0.1:16174', health: { status: 'ok' } }, account: { id: 'xiaohao' } }; },
    listPersonas: async () => { calls.personas += 1; return [{ id: 'dafeiyu-group', name: '大肥鱼（群聊版）' }]; },
  };
}

test('group brain RPC persists wechat personal settings and reloads the bridge', async () => {
  const store = fakeStore();
  const manager = fakeWechatManager();
  let reloads = 0;
  const handler = createGroupBrainRpcHandler({
    store,
    listBrains: () => [],
    reloadBrains: async () => { reloads += 1; },
    wechatPersonalManager: manager,
  });
  const saved = await handler(GROUP_BRAIN_ENDPOINTS.set, {
    wechatPersonal: {
      enabled: true,
      daemonUrl: 'http://127.0.0.1:16174/',
      tokenPath: '/tmp/api-token',
      accountId: 'xiaohao',
      personaId: 'dafeiyu-group',
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.wechatPersonal.enabled, true);
  assert.equal(saved.value.wechatPersonal.daemonUrl, 'http://127.0.0.1:16174');
  assert.equal(reloads, 1);
  assert.equal(manager.calls.reload, 1);

  const status = await handler(GROUP_BRAIN_ENDPOINTS.status, {});
  assert.equal(status.ok, true);
  assert.deepEqual(status.value.wechatPersonal, { configured: true, running: true, account: { id: 'xiaohao' } });

  const tested = await handler(GROUP_BRAIN_ENDPOINTS.testWechatPersonal, {});
  assert.equal(tested.ok, true);
  assert.equal(manager.calls.test, 1);

  const personas = await handler(GROUP_BRAIN_ENDPOINTS.wechatPersonalPersonas, {});
  assert.equal(personas.ok, true);
  assert.equal(personas.value.personas[0].id, 'dafeiyu-group');
  assert.equal(manager.calls.personas, 1);
});

test('group brain RPC reports wechat personal unavailable without a manager', async () => {
  const handler = createGroupBrainRpcHandler({
    store: fakeStore(),
    listBrains: () => [],
    reloadBrains: async () => {},
  });
  const tested = await handler(GROUP_BRAIN_ENDPOINTS.testWechatPersonal, {});
  assert.equal(tested.ok, false);
  assert.equal(tested.error.code, 'wechat-personal-unavailable');
});

test('group brain RPC tests the feiyu voice service with draft settings', async () => {
  const calls = [];
  class FakeVoiceClient {
    constructor(options) { calls.push({ kind: 'construct', options }); }
    async speak({ text, style }) { calls.push({ kind: 'speak', text, style }); return new Uint8Array(1234); }
  }
  const handler = createGroupBrainRpcHandler({
    store: fakeStore(),
    listBrains: () => [],
    reloadBrains: async () => {},
    voiceClientClass: FakeVoiceClient,
  });
  const result = await handler(GROUP_BRAIN_ENDPOINTS.testVoice, {
    serviceUrl: 'http://127.0.0.1:9880',
    style: 'gentle',
    apiKeyPath: '',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.style, 'gentle');
  assert.equal(result.value.byteLength, 1234);
  assert.equal(calls[0].options.baseUrl, 'http://127.0.0.1:9880');
  assert.equal(calls[1].style, 'gentle');

  const invalid = await handler(GROUP_BRAIN_ENDPOINTS.testVoice, {});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');
});
