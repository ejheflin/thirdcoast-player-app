import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractGame, appendGames } from './activities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'activities-5056669.json'), 'utf8'));

test('extractGame reads a real played game with result+score', () => {
  const played = raw.map((e) => e.activity).find((a) => a.state === 'played_regular_time');
  assert.ok(played, 'fixture must contain at least one played game');
  const game = extractGame(played);
  assert.ok(game);
  assert.equal(game.activityId, played.id);
  assert.equal(game.teams.length, 2);
  assert.ok(['win', 'loss', 'tie'].includes(game.teams[0].result));
  assert.equal(typeof game.teams[0].score, 'number');
});

test('extractGame returns null for a not-yet-played activity', () => {
  const scheduled = { id: 1, state: 'scheduled', start: { date: '2026-09-01' }, teams: [] };
  assert.equal(extractGame(scheduled), null);
});

test('appendGames deduplicates by activityId and never drops existing entries', () => {
  const existing = [{ activityId: 1, date: '2026-01-01', teams: [] }];
  const merged = appendGames(existing, [
    { activityId: 1, date: '2026-01-01', teams: [] }, // same game, seen again
    { activityId: 2, date: '2026-01-08', teams: [] }, // genuinely new
  ]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((g) => g.activityId === 1));
  assert.ok(merged.some((g) => g.activityId === 2));
});
