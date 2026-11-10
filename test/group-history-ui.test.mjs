import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { GlobalSettingsPanel } from '../plugin-src/client/global-settings.js';
import { callManagementRpc } from '../plugin-src/management-rpc.mjs';
import { en, ru, setImTranslator } from '../plugin-src/client/i18n.js';

test('general and attachment panels display translated management failures without retrying', async () => {
  for (const dictionary of [null, en, ru]) {
    setImTranslator(dictionary ? key => dictionary[key] ?? key : undefined);
    try {
      for (const status of [401, 403]) {
        const calls = [];
        const messages = [];
        const connection = { rpc: { async call(_channel, endpoint, payload) {
          calls.push(payload.method);
          throw new Error(`transport failure for /api/${endpoint}: HTTP ${status}`);
        } } };
        const rpcCall = async (method, payload, signal) => {
          if (method === 'settings.sidebar-entry.get') return { ok: true, value: { mode: 'auto', visible: true } };
          if (method === 'settings.off-peak.get') {
            return {
              ok: true,
              value: {
                enabled: false,
                offPeakNow: false,
                activeNow: true,
                schedule: {
                  utcStart: '16:30', utcEnd: '00:30', beijingStart: '00:30', beijingEnd: '08:30',
                },
              },
            };
          }
          if (method === 'settings.group-brain.get') {
            return {
              ok: true,
              value: {
                enabled: true,
                maxMembers: 5,
                allowedGroups: [],
                ambient: { enabled: true, silenceMs: 120000, minMessages: 2, cooldownMs: 600000, maxPerHour: 4, maxPerDay: 40 },
                memory: { consolidateIntervalDays: 30, segmentGapMs: 600000, maxMemoryChars: 16000 },
                profiles: { enabled: true, maxProfiles: 5 },
              },
            };
          }
          if (method === 'settings.group-brain.status') return { ok: true, value: { brains: [] } };
          try { return await callManagementRpc(connection, '/dsh-im-settings', method, payload, signal); }
          catch (error) { messages.push(dictionary?.[error.message] ?? error.message); throw error; }
        };
        let renderer;
        try {
          await act(async () => { renderer = create(React.createElement(GlobalSettingsPanel, { rpcCall })); });
          assert.deepEqual(renderer.root.findAllByProps({ role: 'alert' }).map(node => node.children.join('')), [messages[0]]);
          await act(async () => { renderer.root.findByProps({ id: 'dim-general-settings-tab-attachments' }).props.onClick(); });
          const alerts = renderer.root.findAllByProps({ role: 'alert' }).map(node => node.children.join(''));
          assert.equal(alerts.length, 2, 'both TTL and image settings must present the failure');
          assert.ok(alerts.every(message => message === messages[0]));
          if (status === 403) assert.ok(alerts.every(message => message.includes('HTTP 403')));
          if (dictionary) assert.ok(alerts.every(message => !/[\u4e00-\u9fff]/.test(message)));
          assert.deepEqual(calls.toSorted(), ['settings.group-brain.wechat-personal.personas', 'settings.group-history.get', 'settings.image-input.get', 'settings.inbound-ttl.get']);
        } finally { if (renderer) await act(async () => renderer.unmount()); }
      }
    } finally { setImTranslator(undefined); }
  }
});

test('General tab configures sidebar and retention and retains Attachments navigation', async () => {
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'settings.sidebar-entry.get') return { ok: true, value: { mode: 'auto', visible: true } };
    if (endpoint === 'settings.group-history.get') return { ok: true, value: { groupHistoryRetentionDays: 14 } };
    if (endpoint === 'settings.group-history.set') return { ok: true, value: payload };
    if (endpoint === 'settings.inbound-ttl.get') return { ok: true, value: { ttlHours: 24 } };
    if (endpoint === 'settings.off-peak.get') {
      return {
        ok: true,
        value: {
          enabled: false,
          offPeakNow: false,
          activeNow: true,
          schedule: {
            utcStart: '16:30', utcEnd: '00:30', beijingStart: '00:30', beijingEnd: '08:30',
          },
        },
      };
    }
    if (endpoint === 'settings.group-brain.get') {
      return {
        ok: true,
        value: {
          enabled: true,
          maxMembers: 5,
          allowedGroups: [],
          ambient: { enabled: true, silenceMs: 120000, minMessages: 2, cooldownMs: 600000, maxPerHour: 4, maxPerDay: 40 },
          memory: { consolidateIntervalDays: 30, segmentGapMs: 600000, maxMemoryChars: 16000 },
          profiles: { enabled: true, maxProfiles: 5 },
        },
      };
    }
    if (endpoint === 'settings.group-brain.status') return { ok: true, value: { brains: [] } };
    return { ok: false, error: { message: 'unexpected endpoint' } };
  };
  let renderer;
  await act(async () => { renderer = create(React.createElement(GlobalSettingsPanel, { rpcCall })); });
  const historyForm = () => renderer.root.findByProps({ 'aria-label': '群聊天记录' });
  const input = () => historyForm().findByProps({ type: 'number' });
  assert.equal(input().props.value, '14');
  assert.equal(renderer.root.findAllByProps({ role: 'switch' }).length, 5);
  assert.equal(renderer.root.findAllByProps({ className: 'dim-groupHistoryList' }).length, 0);
  assert.deepEqual(calls.map((call) => call.endpoint), ['settings.sidebar-entry.get', 'settings.group-history.get', 'settings.off-peak.get', 'settings.group-brain.get', 'settings.group-brain.status', 'settings.group-brain.wechat-personal.personas']);
  assert.equal(renderer.root.findAllByProps({ type: 'submit' }).length, 1,
    'only retention settings need a Save button');
  assert.equal(renderer.root.findByProps({ 'aria-label': '侧边栏入口' }).findAllByType('form').length, 0);
  const form = () => historyForm().findByType('form');
  await act(async () => { input().props.onChange({ target: { value: '0' } }); });
  await act(async () => { await form().props.onSubmit({ preventDefault() {} }); });
  assert.equal(calls.filter((call) => call.endpoint.endsWith('.set')).length, 0);
  await act(async () => { input().props.onChange({ target: { value: '30' } }); });
  await act(async () => { await form().props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(calls.at(-1), { endpoint: 'settings.group-history.set', payload: { groupHistoryRetentionDays: 30 } });
  await act(async () => { renderer.root.findByProps({ id: 'dim-general-settings-tab-attachments' }).props.onClick(); });
  assert.equal(renderer.root.findByProps({ id: 'dim-globalTtlInput' }).props.value, '24');
  act(() => renderer.unmount());
});
