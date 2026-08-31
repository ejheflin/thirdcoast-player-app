import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUpcomingGame } from './schedule.js';

const courtNameFn = (id) => (id === 70291 ? 'Court 2' : null);

test('extractUpcomingGame reads a real scheduled activity with a future date', () => {
  const activity = {
    id: 1234,
    state: 'scheduled',
    type: 'game_season',
    start: { date: '2026-09-10', time: '19:00' },
    subLocationId: 70291,
    teams: [
      { teamId: 10, teamName: 'Team A' },
      { teamId: 11, teamName: 'Team B' },
    ],
  };
  const game = extractUpcomingGame(activity, '2026-08-31', courtNameFn);
  assert.deepEqual(game, {
    activityId: 1234,
    date: '2026-09-10',
    time: '19:00',
    courtName: 'Court 2',
    teams: [
      { teamId: 10, teamName: 'Team A' },
      { teamId: 11, teamName: 'Team B' },
    ],
  });
});

test('extractUpcomingGame excludes a rescheduled activity regardless of its date', () => {
  const activity = {
    id: 1235,
    state: 'rescheduled',
    type: 'game_season',
    start: { date: '2026-09-10', time: '19:00' },
    subLocationId: 70291,
    teams: [
      { teamId: 10, teamName: 'Team A' },
      { teamId: 11, teamName: 'Team B' },
    ],
  };
  assert.equal(extractUpcomingGame(activity, '2026-08-31', courtNameFn), null);
});

test('extractUpcomingGame excludes a tournament marker (event_tournament)', () => {
  const activity = {
    id: 1236,
    state: 'scheduled',
    type: 'event_tournament',
    start: { date: '2026-09-10', time: '19:00' },
    subLocationId: 70291,
    teams: [
      { teamId: 10, teamName: 'Team A' },
      { teamId: 11, teamName: 'Team B' },
    ],
  };
  assert.equal(extractUpcomingGame(activity, '2026-08-31', courtNameFn), null);
});

test('extractUpcomingGame excludes a scheduled activity whose date is before todayISO', () => {
  const activity = {
    id: 1237,
    state: 'scheduled',
    type: 'game_season',
    start: { date: '2026-08-01', time: '19:00' },
    subLocationId: 70291,
    teams: [
      { teamId: 10, teamName: 'Team A' },
      { teamId: 11, teamName: 'Team B' },
    ],
  };
  assert.equal(extractUpcomingGame(activity, '2026-08-31', courtNameFn), null);
});

test('extractUpcomingGame redacts an unabbreviated doubles team name to "First L." shape', () => {
  const activity = {
    id: 1239,
    state: 'scheduled',
    type: 'game_season',
    start: { date: '2026-09-10', time: '19:00' },
    subLocationId: 70291,
    teams: [
      { teamId: 10, teamName: 'Jordan Fakename and Casey Madeupname' },
      { teamId: 11, teamName: 'Team B' },
    ],
  };
  const game = extractUpcomingGame(activity, '2026-08-31', courtNameFn);
  assert.deepEqual(game.teams, [
    { teamId: 10, teamName: 'Jordan F. and Casey M.' },
    { teamId: 11, teamName: 'Team B' },
  ]);
});

test('extractUpcomingGame returns null, not a throw, for a scheduled activity with no teams', () => {
  const activity = {
    id: 1238,
    state: 'scheduled',
    type: 'game_season',
    start: { date: '2026-09-10', time: '19:00' },
    subLocationId: 70291,
    teams: [],
  };
  assert.equal(extractUpcomingGame(activity, '2026-08-31', courtNameFn), null);
});

// Same JSON-API entity bug as activities.js: the schedule feed's teamName
// can arrive entity-encoded. Invented name, per the project's rule against
// reusing real captured team names as test examples.
test('extractUpcomingGame decodes HTML entities in a team name from the JSON API', () => {
  const activity = {
    id: 1240,
    state: 'scheduled',
    type: 'game_season',
    start: { date: '2026-09-10', time: '19:00' },
    subLocationId: 70291,
    teams: [
      { teamId: 10, teamName: '6. Barrio&#39;s Best' },
      { teamId: 11, teamName: 'Nets &amp; Chill' },
    ],
  };
  const game = extractUpcomingGame(activity, '2026-08-31', courtNameFn);
  assert.deepEqual(game.teams, [
    { teamId: 10, teamName: "6. Barrio's Best" },
    { teamId: 11, teamName: 'Nets & Chill' },
  ]);
});

test('extractUpcomingGame decodes before redacting, so a redacted name is never left entity-encoded', () => {
  const activity = {
    id: 1241,
    state: 'scheduled',
    type: 'game_season',
    start: { date: '2026-09-10', time: '19:00' },
    subLocationId: 70291,
    teams: [
      { teamId: 10, teamName: 'Dune Kicker&#39;s (Jordan Fakename)' },
      { teamId: 11, teamName: 'Team B' },
    ],
  };
  const game = extractUpcomingGame(activity, '2026-08-31', courtNameFn);
  assert.equal(game.teams[0].teamName, "Dune Kicker's (Jordan F.)");
});
