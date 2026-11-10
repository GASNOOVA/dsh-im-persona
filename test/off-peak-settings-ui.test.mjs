import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { OffPeakSettings } from '../plugin-src/client/off-peak-settings.js';

const SYNCED_AT = '2026-11-10T07:00:00.000Z';
const schedule = {
  timezone: 'Asia/Shanghai (UTC+8)',
  peakWindows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  weekdays: '周一至周五',
  weekendOffPeak: true,
  holidaysOffPeak: true,
  builtinHolidayYears: [2026, 2027],
  holidayDates: ['2026-10-01', '2027-01-01'],
  syncedHolidays: [],
  syncedAt: null,
};
const status = (enabled, offPeakNow, overrides = {}) => ({
  ok: true,
  value: {
    enabled,
    offPeakNow,
    activeNow: !enabled || offPeakNow,
    schedule: { ...schedule, ...overrides },
  },
});
const allText = (renderer) => renderer.root
  .findAll((node) => typeof node.type === 'string')
  .flatMap((node) => (Array.isArray(node.children) ? node.children : []))
  .filter((child) => typeof child === 'string')
  .join('\n');
const findButton = (renderer, label) => renderer.root
  .findAllByType('button')
  .find((node) => node.children.join('') === label);

async function render(rpcCall) {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(OffPeakSettings, { rpcCall }));
  });
  return renderer;
}

test('off-peak toggle saves through the settings RPC and shows the current phase', async (t) => {
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (endpoint === 'settings.off-peak.get') return status(false, false);
    if (endpoint === 'settings.off-peak.set') return status(payload.enabled === true, true);
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(OffPeakSettings, { rpcCall }));
  });
  t.after(() => act(() => renderer.unmount()));
  const toggle = renderer.root.findByProps({ role: 'switch' });
  await act(async () => {
    toggle.props.onChange({ target: { checked: true } });
  });
  assert.deepEqual(calls[1], ['settings.off-peak.set', { enabled: true }]);
  assert.match(allText(renderer), /已开启，当前为空闲时段（半价），机器人正常响应。/u);
});

test('off-peak UI reports the peak-hour model skip while enabled', async (t) => {
  const rpcCall = async (endpoint) => {
    if (endpoint === 'settings.off-peak.get') return status(true, false);
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const renderer = await render(rpcCall);
  t.after(() => act(() => renderer.unmount()));
  const text = allText(renderer);
  assert.match(text, /当前为高峰时段，不调用模型，仅自动回复固定提示/u);
  assert.match(text, /法定节假日表/u);
  assert.match(text, /尚未同步节假日；当前使用内置 2026、2027 年节假日表/u);
  assert.ok(findButton(renderer, '同步节假日'));
});

test('sync holidays calls the RPC and shows the synced count', async (t) => {
  const calls = [];
  const rpcCall = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === 'settings.off-peak.get') return status(true, true);
    if (endpoint === 'settings.off-peak.sync-holidays') {
      return status(true, true, {
        syncedHolidays: ['2026-10-01', '2027-01-01'],
        syncedAt: SYNCED_AT,
      });
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const renderer = await render(rpcCall);
  t.after(() => act(() => renderer.unmount()));
  const button = findButton(renderer, '同步节假日');
  await act(async () => { button.props.onClick(); });
  assert.deepEqual(calls, ['settings.off-peak.get', 'settings.off-peak.sync-holidays']);
  assert.match(allText(renderer), /已同步 2 个节假日/u);
});

test('a failed holiday sync shows an alert and keeps the previous table', async (t) => {
  const rpcCall = async (endpoint) => {
    if (endpoint === 'settings.off-peak.get') return status(true, true);
    if (endpoint === 'settings.off-peak.sync-holidays') {
      throw new Error('节假日同步失败，请检查网络后重试。');
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const renderer = await render(rpcCall);
  t.after(() => act(() => renderer.unmount()));
  const button = findButton(renderer, '同步节假日');
  await act(async () => { button.props.onClick(); });
  assert.match(allText(renderer), /节假日同步失败，请检查网络后重试。/u);
  assert.ok(renderer.root.findAllByProps({ role: 'alert' }).length >= 1);
  assert.match(allText(renderer), /尚未同步节假日/u);
});
