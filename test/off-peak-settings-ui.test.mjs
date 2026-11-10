import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { OffPeakSettings } from '../plugin-src/client/off-peak-settings.js';

const schedule = {
  utcStart: '16:30', utcEnd: '00:30', beijingStart: '00:30', beijingEnd: '08:30',
};
const status = (enabled, offPeakNow) => ({
  ok: true,
  value: { enabled, offPeakNow, activeNow: !enabled || offPeakNow, schedule },
});

test('off-peak toggle saves through the settings RPC and shows the current phase', async (t) => {
  let enabled = false;
  const calls = [];
  let renderer;
  const rpcCall = async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (endpoint === 'settings.off-peak.get') return status(enabled, false);
    enabled = payload.enabled;
    return status(enabled, false);
  };
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { renderer = create(React.createElement(OffPeakSettings, { rpcCall })); });

  const toggle = () => renderer.root.findByProps({ role: 'switch' });
  assert.equal(toggle().props.checked, false);
  assert.equal(toggle().props.disabled, false);
  assert.deepEqual(calls, [['settings.off-peak.get', {}]]);
  assert.match(
    renderer.root.findAllByProps({ className: 'dim-botGeneralHelp' })
      .map((node) => String(node.children.join('')))
      .join('\n'),
    /已关闭，机器人始终响应消息。/u,
  );

  await act(async () => toggle().props.onChange({ target: { checked: true } }));
  assert.deepEqual(calls.at(-1), ['settings.off-peak.set', { enabled: true }]);
  assert.equal(toggle().props.checked, true);
  assert.equal(renderer.root.findByProps({ role: 'status' }).children.join(''), '已保存');

  await act(async () => toggle().props.onChange({ target: { checked: false } }));
  assert.equal(toggle().props.checked, false);
});

test('off-peak UI reports the peak-hour drop state while enabled', async (t) => {
  const value = status(true, false);
  let renderer;
  const rpcCall = async () => value;
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { renderer = create(React.createElement(OffPeakSettings, { rpcCall })); });
  const text = renderer.root.findAllByProps({ className: 'dim-botGeneralHelp' })
    .map((node) => String(node.children.join('')))
    .join('\n');
  assert.match(text, /已开启，当前为高峰时段，入站消息将被静默丢弃/u);
  assert.equal(renderer.root.findByProps({ role: 'switch' }).props.checked, true);
});

test('off-peak save failure rolls back, shows the error, and retry re-saves', async (t) => {
  let fail = true;
  let renderer;
  const rpcCall = async (endpoint, payload) => {
    if (endpoint === 'settings.off-peak.get') return status(false, false);
    if (fail) return { ok: false, error: { code: 'off-peak-settings-unavailable', message: '设置不可用' } };
    return status(payload.enabled, false);
  };
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { renderer = create(React.createElement(OffPeakSettings, { rpcCall })); });
  const toggle = () => renderer.root.findByProps({ role: 'switch' });

  await act(async () => toggle().props.onChange({ target: { checked: true } }));
  assert.equal(toggle().props.checked, false, 'a failed save must not appear applied');
  assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), '设置不可用');

  fail = false;
  await act(async () => renderer.root.findByType('button').props.onClick());
  assert.equal(toggle().props.checked, true);
  assert.equal(renderer.root.findAllByType('button').length, 0);
});
