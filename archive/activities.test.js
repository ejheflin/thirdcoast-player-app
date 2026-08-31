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

// Real bug, found in committed data: the JSON activities feed can hand back
// a team name with a literal HTML entity in it, which then double-escapes
// into "&amp;#39;" once the browser re-escapes it on render. Invented name
// (project rule: never reuse a real captured team name as a test example).
test('extractGame decodes HTML entities in a team name from the JSON API', () => {
  const activity = {
    id: 4242,
    state: 'played_regular_time',
    start: { date: '2026-08-01' },
    teams: [
      { teamId: 10, teamName: '6. Barrio&#39;s Best', result: 'win', score: 2 },
      { teamId: 11, teamName: 'Nets &amp; Chill', result: 'loss', score: 0 },
    ],
  };
  const game = extractGame(activity);
  assert.equal(game.teams[0].teamName, "6. Barrio's Best");
  assert.equal(game.teams[1].teamName, 'Nets & Chill');
});

test('extractGame decodes before redacting, so a redacted name is never left entity-encoded', () => {
  const activity = {
    id: 4243,
    state: 'played_regular_time',
    start: { date: '2026-08-01' },
    teams: [
      { teamId: 12, teamName: 'Dune Kicker&#39;s (Jordan Fakename)', result: 'win', score: 2 },
      { teamId: 13, teamName: 'Team B', result: 'loss', score: 0 },
    ],
  };
  const game = extractGame(activity);
  assert.equal(game.teams[0].teamName, "Dune Kicker's (Jordan F.)");
});
