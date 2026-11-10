import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  BUILTIN_OFF_PEAK_HOLIDAYS,
  DEEPSEEK_PEAK_WINDOWS,
  isOffPeakAt,
  isPeakAt,
  normalizeOffPeakSettings,
  offPeakStatus,
  shouldBlockInbound,
} from '../src/channels/shared/off-peak.mjs';
import { OffPeakSettingsStore } from '../src/channels/shared/off-peak-settings-store.mjs';
import { createOffPeakRpcHandler, OFF_PEAK_ENDPOINTS } from '../plugin-src/host/off-peak-rpc.mjs';

const at = (iso) => new Date(iso);
const RPC = {
  get: OFF_PEAK_ENDPOINTS.get,
  set: OFF_PEAK_ENDPOINTS.set,
  syncHolidays: OFF_PEAK_ENDPOINTS.syncHolidays,
};
const SCHEDULE = {
  timezone: 'Asia/Shanghai (UTC+8)',
  peakWindows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  weekdays: '周一至周五',
  weekendOffPeak: true,
  holidaysOffPeak: true,
  builtinHolidayYears: [2026, 2027],
  holidayDates: [...BUILTIN_OFF_PEAK_HOLIDAYS],
  syncedHolidays: [],
  syncedAt: null,
};
const statusWith = (enabled, now, overrides = {}) => {
  const status = offPeakStatus({ enabled, ...overrides }, now);
  return status;
};

test('DeepSeek peak hours are 09:00–12:00 and 14:00–18:00 Beijing time on weekdays', () => {
  assert.deepEqual(DEEPSEEK_PEAK_WINDOWS.map(({ start, end }) => ({ start, end })), [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ]);
  // 2026-11-09 is a Monday: 09:00–12:00 Beijing = 01:00–04:00 UTC.
  assert.equal(isPeakAt(at('2026-11-09T00:59:59.000Z')), false);
  assert.equal(isPeakAt(at('2026-11-09T01:00:00.000Z')), true);
  assert.equal(isPeakAt(at('2026-11-09T03:59:59.000Z')), true);
  assert.equal(isPeakAt(at('2026-11-09T04:00:00.000Z')), false);
  // 14:00–18:00 Beijing = 06:00–10:00 UTC.
  assert.equal(isPeakAt(at('2026-11-09T05:59:59.000Z')), false);
  assert.equal(isPeakAt(at('2026-11-09T06:00:00.000Z')), true);
  assert.equal(isPeakAt(at('2026-11-09T09:59:59.000Z')), true);
  assert.equal(isPeakAt(at('2026-11-09T10:00:00.000Z')), false);
  assert.equal(isPeakAt(at('2026-11-09T18:00:00.000Z')), false);
  assert.equal(isPeakAt(new Date('invalid')), false);
});

test('weekends and Chinese statutory holidays are off-peak all day', () => {
  // Saturday 2026-11-07 and Sunday 2026-11-08 at 10:00 Beijing.
  assert.equal(isPeakAt(at('2026-11-07T02:00:00.000Z')), false);
  assert.equal(isPeakAt(at('2026-11-08T02:00:00.000Z')), false);
  assert.equal(isOffPeakAt(at('2026-11-07T02:00:00.000Z')), true);
  // National Day 2026-10-01 (Thursday) 10:00 Beijing.
  assert.equal(isPeakAt(at('2026-10-01T02:00:00.000Z')), false);
  assert.equal(isOffPeakAt(at('2026-10-01T02:00:00.000Z')), true);
  // First working day after the holiday, 2026-10-08 10:00 Beijing, is peak again.
  assert.equal(isPeakAt(at('2026-10-08T02:00:00.000Z')), true);
  // Spring Festival 2027-02-08 (Monday) 10:00 Beijing.
  assert.equal(isPeakAt(at('2027-02-08T02:00:00.000Z')), false);
  // Make-up work Sunday 2027-02-14 stays off-peak all day.
  assert.equal(isPeakAt(at('2027-02-14T02:00:00.000Z')), false);
});

test('off-peak settings normalize strictly and support synced holidays', () => {
  assert.deepEqual(normalizeOffPeakSettings({ enabled: true }), {
    enabled: true,
    syncedHolidays: [],
    syncedAt: null,
  });
  assert.deepEqual(
    normalizeOffPeakSettings({
      enabled: true,
      syncedHolidays: ['2028-01-01', '2027-12-31', '2027-12-31'],
      syncedAt: '2026-11-10T07:00:00.000Z',
    }),
    {
      enabled: true,
      syncedHolidays: ['2027-12-31', '2028-01-01'],
      syncedAt: '2026-11-10T07:00:00.000Z',
    },
  );
  for (const value of [
    null, undefined, {}, { enabled: 'yes' }, { enabled: 1 }, [], 'enabled',
    { enabled: true, syncedHolidays: '2027-12-31' },
    { enabled: true, syncedHolidays: ['2027-13-01'] },
    { enabled: true, syncedHolidays: ['not-a-date'] },
    { enabled: true, syncedAt: 'not-a-date' },
    { enabled: true, syncedAt: 123 },
  ]) {
    assert.equal(normalizeOffPeakSettings(value), null);
  }
  assert.deepEqual(offPeakStatus(undefined, at('2026-11-10T02:00:00.000Z')), {
    enabled: false,
    offPeakNow: false,
    activeNow: true,
    schedule: SCHEDULE,
  });
});

test('shouldBlockInbound drops messages only while enabled and during peak hours', () => {
  const peak = at('2026-11-10T02:00:00.000Z'); // Tuesday 10:00 Beijing
  const offPeak = at('2026-11-10T10:00:00.000Z'); // Tuesday 18:00 Beijing
  assert.equal(shouldBlockInbound({ enabled: false }, peak), false);
  assert.equal(shouldBlockInbound({ enabled: false }, offPeak), false);
  assert.equal(shouldBlockInbound({ enabled: true }, peak), true);
  assert.equal(shouldBlockInbound({ enabled: true }, offPeak), false);
  assert.equal(shouldBlockInbound({ enabled: 'yes' }, peak), false);
  assert.equal(shouldBlockInbound({ enabled: true, syncedHolidays: ['2026-11-10'] }, peak), false);
});

test('off-peak store persists a versioned document and keeps fail-open defaults', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-offpeak-store-'));
  t.after(() => rm(dshHome, { recursive: true, force: true }));
  const path = join(dshHome, 'integrations', 'dsh-im', 'off-peak-settings.json');
  const store = new OffPeakSettingsStore(path);

  assert.deepEqual(await store.get(), { enabled: false, syncedHolidays: [], syncedAt: null });
  assert.equal(store.shouldBlockInbound(at('2026-11-10T02:00:00.000Z')), false);
  await store.set({ enabled: true });
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(document, {
    version: 2,
    offPeak: { enabled: true, syncedHolidays: [], syncedAt: null },
  });
  assert.equal(store.shouldBlockInbound(at('2026-11-10T02:00:00.000Z')), true);
  assert.equal(store.shouldBlockInbound(at('2026-11-10T10:00:00.000Z')), false);

  const reloaded = new OffPeakSettingsStore(path);
  assert.deepEqual(await reloaded.get(), { enabled: true, syncedHolidays: [], syncedAt: null });

  await assert.rejects(store.set({ enabled: 'yes' }), TypeError);

  await writeFile(path, '{ not json', 'utf8');
  const broken = new OffPeakSettingsStore(path);
  await assert.rejects(broken.get(), SyntaxError);
  assert.equal(broken.shouldBlockInbound(at('2026-11-10T02:00:00.000Z')), false);
  // Saving repairs a corrupt document instead of leaving the settings page stuck.
  assert.deepEqual(await broken.set({ enabled: true }), {
    enabled: true,
    syncedHolidays: [],
    syncedAt: null,
  });
  assert.deepEqual(await broken.get(), { enabled: true, syncedHolidays: [], syncedAt: null });
});

test('off-peak store migrates a v1 document that held extraHolidays', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-offpeak-migrate-'));
  t.after(() => rm(dshHome, { recursive: true, force: true }));
  const path = join(dshHome, 'integrations', 'dsh-im', 'off-peak-settings.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    version: 1,
    offPeak: { enabled: true, extraHolidays: ['2028-01-01', '2028-02-02'] },
  }, null, 2), 'utf8');
  const store = new OffPeakSettingsStore(path);
  assert.deepEqual(await store.get(), {
    enabled: true,
    syncedHolidays: ['2028-01-01', '2028-02-02'],
    syncedAt: null,
  });
  await store.set({ enabled: true, syncedHolidays: ['2028-01-01'], syncedAt: '2026-11-10T07:00:00.000Z' });
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.version, 2);
  assert.deepEqual(document.offPeak.syncedHolidays, ['2028-01-01']);
});

test('off-peak RPC reports status, validates payloads, and preserves synced holidays', async () => {
  const settings = {
    enabled: false,
    syncedHolidays: ['2027-12-31'],
    syncedAt: '2026-11-10T07:00:00.000Z',
  };
  const store = {
    async get() {
      return { ...settings, syncedHolidays: [...settings.syncedHolidays] };
    },
    async set(value) {
      Object.assign(settings, value);
      settings.syncedHolidays = [...value.syncedHolidays];
      return { ...settings, syncedHolidays: [...settings.syncedHolidays] };
    },
    shouldBlockInbound() { return false; },
  };
  const handler = createOffPeakRpcHandler(store, { now: () => at('2026-11-10T02:00:00.000Z') });

  const initial = await handler(RPC.get, {});
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.value, {
    enabled: false,
    offPeakNow: false,
    activeNow: true,
    schedule: {
      ...SCHEDULE,
      holidayDates: [...BUILTIN_OFF_PEAK_HOLIDAYS, '2027-12-31'].sort(),
      syncedHolidays: ['2027-12-31'],
      syncedAt: '2026-11-10T07:00:00.000Z',
    },
  });
  const saved = await handler(RPC.set, { enabled: true });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.enabled, true);
  assert.equal(saved.value.activeNow, false);
  assert.deepEqual(saved.value.schedule.syncedHolidays, ['2027-12-31']);
  assert.equal((await handler(RPC.set, { enabled: 'yes' })).error.code, 'bad-request');
  assert.equal((await handler(RPC.set, { enabled: true, extraHolidays: ['bad'] })).error.code, 'bad-request');
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

test('off-peak RPC syncs holidays through the injected loader and keeps the switch state', async () => {
  const settings = { enabled: true, syncedHolidays: [], syncedAt: null };
  const store = {
    async get() { return { ...settings, syncedHolidays: [...settings.syncedHolidays] }; },
    async set(value) {
      Object.assign(settings, value);
      settings.syncedHolidays = [...value.syncedHolidays];
      return { ...settings, syncedHolidays: [...settings.syncedHolidays] };
    },
    shouldBlockInbound() { return false; },
  };
  let syncCalls = 0;
  const syncHolidays = async () => {
    syncCalls += 1;
    return {
      holidays: ['2028-01-01', '2028-01-02'],
      years: [2028],
      failedYears: [2029],
      fetchedAt: '2026-11-10T08:00:00.000Z',
      source: 'test',
    };
  };
  const handler = createOffPeakRpcHandler(store, {
    now: () => at('2026-11-10T10:00:00.000Z'),
    syncHolidays,
  });

  const result = await handler(RPC.syncHolidays, {});
  assert.equal(result.ok, true);
  assert.equal(result.value.enabled, true);
  assert.deepEqual(result.value.schedule.syncedHolidays, ['2028-01-01', '2028-01-02']);
  assert.equal(result.value.schedule.syncedAt, '2026-11-10T08:00:00.000Z');
  assert.deepEqual(result.value.synced, {
    years: [2028],
    failedYears: [2029],
    fetchedAt: '2026-11-10T08:00:00.000Z',
    source: 'test',
  });
  assert.equal(syncCalls, 1);
  assert.equal((await handler(RPC.syncHolidays, { enabled: true })).error.code, 'bad-request');

  const failing = createOffPeakRpcHandler(store, {
    now: () => at('2026-11-10T10:00:00.000Z'),
    syncHolidays: async () => { throw new Error('network'); },
  });
  const failure = await failing(RPC.syncHolidays, {});
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'holiday-sync-failed');
  assert.deepEqual(settings.syncedHolidays, ['2028-01-01', '2028-01-02']);
});

test('embedded holiday table covers all 2026/2027 statutory holiday dates', () => {
  const count2026 = BUILTIN_OFF_PEAK_HOLIDAYS.filter((date) => date.startsWith('2026-')).length;
  const count2027 = BUILTIN_OFF_PEAK_HOLIDAYS.filter((date) => date.startsWith('2027-')).length;
  assert.equal(count2026, 33);
  assert.equal(count2027, 29);
  assert.equal(new Set(BUILTIN_OFF_PEAK_HOLIDAYS).size, BUILTIN_OFF_PEAK_HOLIDAYS.length);
  assert.equal(statusWith(true, at('2026-11-10T02:00:00.000Z')).offPeakNow, false);
});
