import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venueTodayISO, VENUE_TZ } from './venue.js';

test('VENUE_TZ is the building the games are played in', () => {
  assert.equal(VENUE_TZ, 'America/Chicago');
});

// The whole reason this function exists. The archiver runs on GitHub
// Actions, whose clock is UTC, and its cron fires at 00:00 UTC -- which is
// 19:00 in Houston, with that evening's 19:30/20:30/21:30 games still to
// be played. `new Date().toISOString().slice(0, 10)` called it tomorrow,
// and the schedule gate threw the night away.
test('a 00:30 UTC instant is still the previous evening at the venue', () => {
  assert.equal(venueTodayISO(new Date('2026-10-08T00:30:00Z')), '2026-10-07');
});

test('a 05:30 UTC instant in winter is still the previous evening at the venue', () => {
  // CST, UTC-6: 23:30 on Jan 14.
  assert.equal(venueTodayISO(new Date('2026-01-15T05:30:00Z')), '2026-01-14');
});

test('the venue day rolls over at local midnight, not UTC midnight', () => {
  // 23:59 CDT Oct 7 -> still Oct 7. One minute later -> Oct 8.
  assert.equal(venueTodayISO(new Date('2026-10-08T04:59:00Z')), '2026-10-07');
  assert.equal(venueTodayISO(new Date('2026-10-08T05:00:00Z')), '2026-10-08');
});

test('a morning UTC instant and the venue agree on the date', () => {
  assert.equal(venueTodayISO(new Date('2026-10-07T12:00:00Z')), '2026-10-07');
});

// Month and day are zero-padded, because the whole site compares these as
// STRINGS -- "2026-9-7" sorts below "2026-10-07" and would break every
// date gate it touches.
test('single-digit months and days are zero-padded', () => {
  assert.equal(venueTodayISO(new Date('2026-09-07T12:00:00Z')), '2026-09-07');
});
