import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUpcomingGame, extractTournamentMarker } from './schedule.js';

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

// ---------------------------------------------------------------------
// extractTournamentMarker -- the program-wide playoff marker the site's
// router reads to tell playoff night from a regular game night. Same
// state/type/date gating as extractUpcomingGame above, mirrored case for
// case, because the router's whole correctness rests on the gating: a
// marker that leaks through from a completed or rescheduled event would
// send a player to the playoffs screen on a normal Tuesday.
//
// The activity shape below is the real live one (see the comment in
// schedule.js): `teams` is empty, `title` is "PLAYOFFS".

test('extractTournamentMarker reads a real scheduled tournament marker with a future date', () => {
  const activity = {
    id: 13275054,
    state: 'scheduled',
    type: 'event_tournament',
    title: 'PLAYOFFS',
    start: { date: '2026-09-02', time: '18:30' },
    end: { date: '2026-09-02', time: '23:55' },
    teams: [],
  };
  assert.deepEqual(extractTournamentMarker(activity, '2026-08-31'), {
    activityId: 13275054,
    date: '2026-09-02',
    time: '18:30',
    title: 'PLAYOFFS',
  });
});

test('extractTournamentMarker carries no teams field: a real marker applies to the whole program', () => {
  const activity = {
    id: 13275054, state: 'scheduled', type: 'event_tournament', title: 'PLAYOFFS',
    start: { date: '2026-09-02', time: '18:30' }, teams: [],
  };
  const marker = extractTournamentMarker(activity, '2026-08-31');
  assert.equal('teams' in marker, false);
});

test('extractTournamentMarker excludes a regular season game (game_season)', () => {
  const activity = {
    id: 1234, state: 'scheduled', type: 'game_season',
    start: { date: '2026-09-10', time: '19:00' }, subLocationId: 70291,
    teams: [{ teamId: 10, teamName: 'Team A' }, { teamId: 11, teamName: 'Team B' }],
  };
  assert.equal(extractTournamentMarker(activity, '2026-08-31'), null);
});

test('extractTournamentMarker excludes a tournament marker that is not state scheduled', () => {
  for (const state of ['rescheduled', 'cancelled', 'played_regular_time']) {
    const activity = {
      id: 13275054, state, type: 'event_tournament', title: 'PLAYOFFS',
      start: { date: '2026-09-02', time: '18:30' }, teams: [],
    };
    assert.equal(extractTournamentMarker(activity, '2026-08-31'), null, `state ${state} must not count`);
  }
});

test('extractTournamentMarker excludes a marker whose date is before todayISO', () => {
  const activity = {
    id: 13275054, state: 'scheduled', type: 'event_tournament', title: 'PLAYOFFS',
    start: { date: '2026-08-30', time: '18:30' }, teams: [],
  };
  assert.equal(extractTournamentMarker(activity, '2026-08-31'), null);
});

// Playoff night ITSELF has to count: this is the one day the playoffs
// screen matters most, and a strict > would hide the marker exactly then.
test('extractTournamentMarker keeps a marker dated todayISO itself', () => {
  const activity = {
    id: 13275054, state: 'scheduled', type: 'event_tournament', title: 'PLAYOFFS',
    start: { date: '2026-08-31', time: '18:30' }, teams: [],
  };
  assert.equal(extractTournamentMarker(activity, '2026-08-31').date, '2026-08-31');
});

test('extractTournamentMarker returns null, not a throw, for a marker with no start date', () => {
  const activity = {
    id: 13275054, state: 'scheduled', type: 'event_tournament', title: 'PLAYOFFS', teams: [],
  };
  assert.equal(extractTournamentMarker(activity, '2026-08-31'), null);
});

test('extractTournamentMarker tolerates a missing time and a missing title rather than throwing', () => {
  const activity = {
    id: 13275054, state: 'scheduled', type: 'event_tournament',
    start: { date: '2026-09-02' }, teams: [],
  };
  assert.deepEqual(extractTournamentMarker(activity, '2026-08-31'), {
    activityId: 13275054, date: '2026-09-02', time: null, title: null,
  });
});

// Same JSON-API entity bug the team-name tests above cover: this title
// comes off the same feed, and the site escapes it again on render.
test('extractTournamentMarker decodes HTML entities in a marker title', () => {
  const activity = {
    id: 13275054, state: 'scheduled', type: 'event_tournament',
    title: 'WOMEN&#39;S PLAYOFFS &amp; FINALS',
    start: { date: '2026-09-02', time: '18:30' }, teams: [],
  };
  assert.equal(extractTournamentMarker(activity, '2026-08-31').title, "WOMEN'S PLAYOFFS & FINALS");
});
