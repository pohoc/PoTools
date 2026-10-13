import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDatePreset } from '../src/lib/date-presets.ts';

/** 2026-10-12 is a Monday; 15:34:56 keeps the time portion visible. */
const monday = new Date(2026, 9, 12, 15, 34, 56);

test('now echoes the full current timestamp', () => {
  assert.equal(resolveDatePreset('now', monday), '2026-10-12 15:34:56');
});

test('today is midnight of the same day', () => {
  assert.equal(resolveDatePreset('today', monday), '2026-10-12 00:00:00');
});

test('yesterday and tomorrow step one day at midnight', () => {
  assert.equal(resolveDatePreset('yesterday', monday), '2026-10-11 00:00:00');
  assert.equal(resolveDatePreset('tomorrow', monday), '2026-10-13 00:00:00');
});

test('week-start on a Monday is the same day at midnight', () => {
  assert.equal(resolveDatePreset('week-start', monday), '2026-10-12 00:00:00');
});

test('week-start on a Sunday walks back to the previous Monday', () => {
  const sunday = new Date(2026, 9, 11, 9, 0, 0);
  assert.equal(resolveDatePreset('week-start', sunday), '2026-10-05 00:00:00');
});

test('week-start on a Saturday also walks back to that Monday', () => {
  const saturday = new Date(2026, 9, 17, 9, 0, 0);
  assert.equal(resolveDatePreset('week-start', saturday), '2026-10-12 00:00:00');
});

test('month-start is the 1st at midnight', () => {
  assert.equal(resolveDatePreset('month-start', monday), '2026-10-01 00:00:00');
});

test('quarter-start maps months to their quarter head', () => {
  assert.equal(resolveDatePreset('quarter-start', new Date(2026, 0, 20)), '2026-01-01 00:00:00');
  assert.equal(resolveDatePreset('quarter-start', new Date(2026, 4, 20)), '2026-04-01 00:00:00');
  assert.equal(resolveDatePreset('quarter-start', new Date(2026, 7, 20)), '2026-07-01 00:00:00');
  assert.equal(resolveDatePreset('quarter-start', new Date(2026, 11, 31)), '2026-10-01 00:00:00');
});

test('year-start is Jan 1 at midnight', () => {
  assert.equal(resolveDatePreset('year-start', monday), '2026-01-01 00:00:00');
});

test('week-start crosses the year boundary backwards', () => {
  const saturday = new Date(2026, 0, 3, 9, 0, 0);
  assert.equal(resolveDatePreset('week-start', saturday), '2025-12-29 00:00:00');
});

test('identifiers outside the engine keyword set return null', () => {
  assert.equal(resolveDatePreset('nonsense', monday), null);
  assert.equal(resolveDatePreset('', monday), null);
});
