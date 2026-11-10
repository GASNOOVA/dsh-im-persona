import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractHolidayDates,
  fetchChineseHolidays,
  holidaySyncUrl,
  HOLIDAY_SYNC_SOURCE,
} from '../src/channels/shared/holiday-sync.mjs';

const NOW = new Date('2026-11-10T07:00:00.000Z');

function documentWith(year, offDates) {
  return {
    year,
    days: [
      ...offDates.map((date) => ({ name: '假日', date, isOffDay: true })),
      { name: '调休上班', date: `${year}-01-04`, isOffDay: false },
    ],
  };
}

function fakeFetch(map) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const match = /(\d{4})\.json$/u.exec(url);
    const year = match ? Number(match[1]) : null;
    const document = map[year];
    if (!document) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => document };
  };
  impl.calls = calls;
  return impl;
}

test('extractHolidayDates keeps only off days, validates, and dedupes', () => {
  const dates = extractHolidayDates(documentWith(2026, [
    '2026-10-01', '2026-10-01', 'invalid', '2026-10-02',
  ]));
  assert.deepEqual(dates, ['2026-10-01', '2026-10-02']);
  assert.deepEqual(extractHolidayDates({ days: [] }), []);
  assert.equal(extractHolidayDates(null), null);
});

test('holidaySyncUrl points at the holiday-cn yearly JSON', () => {
  assert.equal(holidaySyncUrl(2027), `${HOLIDAY_SYNC_SOURCE}/2027.json`);
});

test('fetchChineseHolidays merges successful years and reports missing ones', async () => {
  const fetchImpl = fakeFetch({
    2026: documentWith(2026, ['2026-10-01', '2026-10-02']),
    2027: documentWith(2027, ['2027-01-01', '2027-02-05']),
  });
  const result = await fetchChineseHolidays({ fetchImpl, now: () => NOW });
  assert.deepEqual(result.years, [2026, 2027]);
  assert.deepEqual(result.failedYears, [2028]);
  assert.deepEqual(result.holidays, ['2026-10-01', '2026-10-02', '2027-01-01', '2027-02-05']);
  assert.equal(result.fetchedAt, NOW.toISOString());
  assert.equal(result.source, HOLIDAY_SYNC_SOURCE);
  assert.deepEqual(fetchImpl.calls.map((url) => Number(/(\d{4})\.json$/u.exec(url)[1])), [2026, 2027, 2028]);
});

test('fetchChineseHolidays accepts an explicit year list and ignores failures', async () => {
  const fetchImpl = fakeFetch({ 2028: documentWith(2028, ['2028-01-01']) });
  const result = await fetchChineseHolidays({ years: [2027, 2028], fetchImpl, now: () => NOW });
  assert.deepEqual(result.years, [2028]);
  assert.deepEqual(result.failedYears, [2027]);
  assert.deepEqual(result.holidays, ['2028-01-01']);
});

test('fetchChineseHolidays throws when every requested year fails', async () => {
  const fetchImpl = fakeFetch({});
  await assert.rejects(
    fetchChineseHolidays({ years: [2028, 2029], fetchImpl, now: () => NOW }),
    /unable to fetch holidays for 2028, 2029/u,
  );
});
