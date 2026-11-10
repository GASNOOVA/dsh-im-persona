import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { GROUP_BRAIN_ENDPOINTS, GroupBrainSettings } from '../plugin-src/client/group-brain-settings.js';

const DEFAULT_SETTINGS = {
  enabled: true,
  maxMembers: 5,
  allowedGroups: [{ channel: 'qq', botId: 'bot-1', chatId: 'group-1', groupName: '小群' }],
  ambient: {
    enabled: true,
    silenceMs: 120_000,
    minMessages: 2,
    cooldownMs: 600_000,
    maxPerHour: 4,
    maxPerDay: 40,
  },
  memory: { consolidateIntervalDays: 30, segmentGapMs: 600_000, maxMemoryChars: 16_000 },
  profiles: { enabled: true, maxProfiles: 5 },
  wechatPersonal: {
    enabled: false,
    daemonUrl: 'http://127.0.0.1:16174',
    tokenPath: '',
    accountId: '',
    personaId: 'dafeiyu-group',
  },
};

function switchInputs(renderer) {
  return renderer.root.findAll((node) => node.type === 'input' && node.props.role === 'switch');
}

async function flush() {
  await act(async () => {});
}

test('group brain settings load, toggle and save through RPC', async (t) => {
  const calls = [];
  let saved = DEFAULT_SETTINGS;
  const rpcCall = async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (endpoint === GROUP_BRAIN_ENDPOINTS.get) return { ok: true, value: saved };
    if (endpoint === GROUP_BRAIN_ENDPOINTS.status) {
      return { ok: true, value: { brains: [{ channel: 'qq', botId: 'bot-1', status: { groups: [{ chatId: 'group-1', groupName: '小群' }] } }] } };
    }
    if (endpoint === GROUP_BRAIN_ENDPOINTS.set) { saved = payload; return { ok: true, value: payload }; }
    if (endpoint === GROUP_BRAIN_ENDPOINTS.consolidate) return { ok: true, value: {} };
    if (endpoint === GROUP_BRAIN_ENDPOINTS.wechatPersonalPersonas) {
      return { ok: true, value: { personas: [{ id: 'dafeiyu-group', name: '大肥鱼（群聊版）' }] } };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  let renderer;
  await act(async () => { renderer = create(React.createElement(GroupBrainSettings, { rpcCall })); });
  t.after(() => act(() => renderer.unmount()));
  await flush();

  const switches = switchInputs(renderer);
  assert.equal(switches.length, 5);
  assert.equal(switches[0].props.checked, true);

  await act(async () => { switches[0].props.onChange({ target: { checked: false } }); });
  const saveButton = renderer.root.findAllByType('button')
    .find((button) => JSON.stringify(button.props.children).includes('保存群聊大脑设置'));
  assert.ok(saveButton, 'save button is rendered');
  await act(async () => { saveButton.props.onClick(); });
  await flush();

  const setCall = calls.find(([endpoint]) => endpoint === GROUP_BRAIN_ENDPOINTS.set);
  assert.ok(setCall, 'settings.set was called');
  assert.equal(setCall[1].enabled, false);
  assert.equal(setCall[1].ambient.enabled, true);
  assert.equal(setCall[1].wechatPersonal.enabled, false);
});

test('group brain settings show a retry path when loading fails', async (t) => {
  let attempts = 0;
  const rpcCall = async (endpoint) => {
    if (endpoint === GROUP_BRAIN_ENDPOINTS.get) {
      attempts += 1;
      return attempts === 1
        ? { ok: false, error: { message: '读取失败' } }
        : { ok: true, value: DEFAULT_SETTINGS };
    }
    return { ok: true, value: { brains: [] } };
  };
  let renderer;
  await act(async () => { renderer = create(React.createElement(GroupBrainSettings, { rpcCall })); });
  t.after(() => act(() => renderer.unmount()));
  await flush();
  assert.equal(switchInputs(renderer).length, 0);
  const retryButton = renderer.root.findAllByType('button')
    .find((button) => JSON.stringify(button.props.children).includes('重试'));
  assert.ok(retryButton, 'retry button is rendered');
  await act(async () => { retryButton.props.onClick(); });
  await flush();
  assert.equal(switchInputs(renderer).length, 5);
});
