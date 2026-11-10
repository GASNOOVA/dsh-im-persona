import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { OffPeakSettings } from '../plugin-src/client/off-peak-settings.js';

const schedule = {
  timezone: 'Asia/Shanghai (UTC+8)',
  peakWindows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  weekdays: '周一至周五',
  weekendOffPeak: true,
  holidaysOffPeak: true,
  holidayDates: [],
  extraHolidays: [],
};
const status = (enabled, offPeakNow, extraHolidays = []) => ({
  ok: true,
  value: {
    enabled,
    offPeakNow,
    activeNow: !enabled || offPeakNow,
    schedule: { ...schedule, extraHolidays },
  },
});
const helpText = (renderer) => renderer.root
  .findAllByProps({ className: 'dim-botGeneralHelp' })
  .map((node) => String(node.children.join('')))
  .join('\n');
const findButton = (renderer, label) => renderer.root
  .findAllByType('button')
  .find((node) => node.children.join('') === label);

test('off-peak toggle saves through the settings RPC and shows the current phase', async (t) => {
  let enabled = false;
  const calls = [];
  let renderer;
  const rpcCall = async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (endpoint === 'settings.off-peak.get') return status(enabled, true);
    enabled = payload.enabled;
    return status(enabled, true);
  };
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { renderer = create(React.createElement(OffPeakSettings, { rpcCall })); });

  const toggle = () => renderer.root.findByProps({ role: 'switch' });
  assert.equal(toggle().props.checked, false);
  assert.equal(toggle().props.disabled, false);
  assert.deepEqual(calls, [['settings.off-peak.get', {}]]);
  assert.match(helpText(renderer), /已关闭，机器人始终响应消息。/u);
  assert.match(helpText(renderer), /高峰时段：北京时间周一至周五 09:00–12:00、14:00–18:00（中国法定节假日除外）/u);
  assert.match(helpText(renderer), /其余时间（工作日窗口外、周末、法定节假日全天.*）为空闲时段，价格减半。/u);

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
  assert.match(helpText(renderer), /已开启，当前为高峰时段，入站消息将被静默丢弃/u);
  assert.equal(renderer.root.findByProps({ role: 'switch' }).props.checked, true);
});

test('extra holidays are parsed, saved, and rejected when malformed', async (t) => {
  const calls = [];
  let renderer;
  const rpcCall = async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (endpoint === 'settings.off-peak.get') return status(false, true, ['2027-12-31']);
    return status(payload.enabled, true, payload.extraHolidays);
  };
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { renderer = create(React.createElement(OffPeakSettings, { rpcCall })); });
  const textarea = () => renderer.root.findByType('textarea');
  assert.equal(textarea().props.value, '2027-12-31');

  await act(async () => textarea().props.onChange({ target: { value: '2028-01-01\n2028-02-02, 2028-03-03' } }));
  await act(async () => findButton(renderer, '保存节假日').props.onClick());
  assert.deepEqual(calls.at(-1), ['settings.off-peak.set', {
    enabled: false,
    extraHolidays: ['2028-01-01', '2028-02-02', '2028-03-03'],
  }]);

  await act(async () => textarea().props.onChange({ target: { value: 'not-a-date' } }));
  await act(async () => findButton(renderer, '保存节假日').props.onClick());
  assert.equal(
    renderer.root.findByProps({ role: 'alert' }).children.join(''),
    '额外节假日格式不正确，请按 YYYY-MM-DD 每行一个填写。',
  );
});

test('off-peak save failure rolls back, shows the error, and retry re-saves', async (t) => {
  let fail = true;
  let renderer;
  const rpcCall = async (endpoint, payload) => {
    if (endpoint === 'settings.off-peak.get') return status(false, true);
    if (fail) return { ok: false, error: { code: 'off-peak-settings-unavailable', message: '设置不可用' } };
    return status(payload.enabled, true);
  };
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { renderer = create(React.createElement(OffPeakSettings, { rpcCall })); });
  const toggle = () => renderer.root.findByProps({ role: 'switch' });

  await act(async () => toggle().props.onChange({ target: { checked: true } }));
  assert.equal(toggle().props.checked, false, 'a failed save must not appear applied');
  assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), '设置不可用');

  fail = false;
  await act(async () => findButton(renderer, '重试').props.onClick());
  assert.equal(toggle().props.checked, true);
  assert.equal(findButton(renderer, '重试'), undefined);
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
});
