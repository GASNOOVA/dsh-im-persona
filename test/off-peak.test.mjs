import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEEPSEEK_OFF_PEAK_WINDOW,
  isOffPeakAt,
  normalizeOffPeakSettings,
  offPeakStatus,
  shouldBlockInbound,
} from '../src/channels/shared/off-peak.mjs';
import { OffPeakSettingsStore } from '../src/channels/shared/off-peak-settings-store.mjs';
import { createOffPeakRpcHandler, OFF_PEAK_ENDPOINTS } from '../plugin-src/host/off-peak-rpc.mjs';

const at = (iso) => new Date(iso);
const RPC = { get: OFF_PEAK_ENDPOINTS.get, set: OFF_PEAK_ENDPOINTS.set };

test('DeepSeek off-peak window wraps UTC midnight and excludes peak hours', () => {
  assert.equal(DEEPSEEK_OFF_PEAK_WINDOW.utcStart, '16:30');
  assert.equal(DEEPSEEK_OFF_PEAK_WINDOW.utcEnd, '00:30');
  // Off-peak starts at 16:30 UTC (00:30 Beijing) and ends at 00:30 UTC (08:30 Beijing).
  assert.equal(isOffPeakAt(at('2026-11-10T16:29:59.000Z')), false);
  assert.equal(isOffPeakAt(at('2026-11-10T16:30:00.000Z')), true);
  assert.equal(isOffPeakAt(at('2026-11-10T23:59:59.000Z')), true);
  assert.equal(isOffPeakAt(at('2026-11-11T00:00:00.000Z')), true);
  assert.equal(isOffPeakAt(at('2026-11-11T00:29:59.000Z')), true);
  assert.equal(isOffPeakAt(at('2026-11-11T00:30:00.000Z')), false);
  assert.equal(isOffPeakAt(at('2026-11-11T12:00:00.000Z')), false);
  assert.equal(isOffPeakAt(new Date('invalid')), false);
});

test('off-peak settings normalize strictly and default to disabled', () => {
  assert.deepEqual(normalizeOffPeakSettings({ enabled: true }), { enabled: true });
  assert.deepEqual(normalizeOffPeakSettings({ enabled: false }), { enabled: false });
  for (const value of [null, undefined, {}, { enabled: 'yes' }, { enabled: 1 }, [], 'enabled']) {
    assert.equal(normalizeOffPeakSettings(value), null);
  }
  assert.deepEqual(offPeakStatus(undefined, at('2026-11-10T12:00:00.000Z')), {
    enabled: false,
    offPeakNow: false,
    activeNow: true,
    schedule: {
      utcStart: '16:30', utcEnd: '00:30', beijingStart: '00:30', beijingEnd: '08:30',
    },
  });
});

test('shouldBlockInbound only drops messages while enabled and during peak hours', () => {
  const peak = at('2026-11-10T12:00:00.000Z');
  const offPeak = at('2026-11-10T18:00:00.000Z');
  assert.equal(shouldBlockInbound({ enabled: false }, peak), false);
  assert.equal(shouldBlockInbound({ enabled: false }, offPeak), false);
  assert.equal(shouldBlockInbound({ enabled: true }, peak), true);
  assert.equal(shouldBlockInbound({ enabled: true }, offPeak), false);
  assert.equal(shouldBlockInbound({ enabled: 'yes' }, peak), false);
});

test('off-peak store persists a versioned document and keeps fail-open defaults', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-offpeak-store-'));
  t.after(() => rm(dshHome, { recursive: true, force: true }));
  const path = join(dshHome, 'integrations', 'dsh-im', 'off-peak-settings.json');
  const store = new OffPeakSettingsStore(path);

  assert.deepEqual(await store.get(), { enabled: false });
  assert.equal(store.shouldBlockInbound(at('2026-11-10T12:00:00.000Z')), false);
  await store.set({ enabled: true });
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(document, { version: 1, offPeak: { enabled: true } });
  assert.equal(store.shouldBlockInbound(at('2026-11-10T12:00:00.000Z')), true);
  assert.equal(store.shouldBlockInbound(at('2026-11-10T18:00:00.000Z')), false);

  const reloaded = new OffPeakSettingsStore(path);
  assert.deepEqual(await reloaded.get(), { enabled: true });

  await assert.rejects(store.set({ enabled: 'yes' }), TypeError);

  await writeFile(path, '{ not json', 'utf8');
  const broken = new OffPeakSettingsStore(path);
  await assert.rejects(broken.get(), SyntaxError);
  assert.equal(broken.shouldBlockInbound(at('2026-11-10T12:00:00.000Z')), false);
  // Saving repairs a corrupt document instead of leaving the settings page stuck.
  assert.deepEqual(await broken.set({ enabled: true }), { enabled: true });
  assert.deepEqual(await broken.get(), { enabled: true });
});

test('off-peak RPC reports status, validates toggles, and maps cancellations', async () => {
  const settings = { enabled: false };
  const store = {
    async get() { return { ...settings }; },
    async set(value) { Object.assign(settings, value); return { ...settings }; },
    shouldBlockInbound() { return false; },
  };
  const handler = createOffPeakRpcHandler(store, { now: () => at('2026-11-10T12:00:00.000Z') });

  const initial = await handler(RPC.get, {});
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.value, {
    enabled: false,
    offPeakNow: false,
    activeNow: true,
    schedule: {
      utcStart: '16:30', utcEnd: '00:30', beijingStart: '00:30', beijingEnd: '08:30',
    },
  });
  assert.deepEqual(await handler(RPC.set, { enabled: true }), {
    ok: true,
    value: {
      enabled: true,
      offPeakNow: false,
      activeNow: false,
      schedule: {
        utcStart: '16:30', utcEnd: '00:30', beijingStart: '00:30', beijingEnd: '08:30',
      },
    },
  });
  assert.equal((await handler(RPC.set, { enabled: 'yes' })).error.code, 'bad-request');
  assert.equal((await handler(RPC.get, { extra: true })).error.code, 'bad-request');
  assert.equal((await handler('settings.off-peak.unknown', {})).error.code, 'bad-request');
  const controller = new AbortController();
  controller.abort();
  assert.equal((await handler(RPC.get, {}, controller.signal)).error.code, 'cancelled');

  const failing = createOffPeakRpcHandler({
    async get() { throw new Error('disk'); },
    async set() { throw new Error('disk'); },
  });
  assert.equal((await failing(RPC.get, {})).error.code, 'off-peak-settings-unavailable');
});
