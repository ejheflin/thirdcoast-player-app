// archive/fetch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runArchive } from './fetch.js';

test('runArchive writes standings for every program, activities+roster only for active ones', async () => {
  const writes = new Map();
  const reads = new Map();
  const deps = {
    fetchPrograms: async () => [
      { id: 1, name: 'Old League', state: 'COMPLETED' },
      { id: 2, name: 'Live League', state: 'LIVE' },
    ],
    fetchActivities: async (ids) => {
      assert.deepEqual(ids, [2], 'only the LIVE/UPCOMING program should be asked for activities');
      return [
        {
          id: 900, programId: 2, state: 'played_regular_time', start: { date: '2026-08-30' },
          teams: [
            { teamId: 10, teamName: 'Team A', result: 'win', score: 2 },
            { teamId: 11, teamName: 'Team B', result: 'loss', score: 0 },
          ],
        },
        {
          id: 901, programId: 2, state: 'scheduled', type: 'game_season',
          start: { date: '2099-01-15', time: '19:00' }, subLocationId: 70291,
          teams: [
            { teamId: 10, teamName: 'Team A' },
            { teamId: 11, teamName: 'Team B' },
          ],
        },
        // The real live shape of a playoff marker: program-wide, no teams.
        // Dated AFTER game 901 so the ordering assertion below is real.
        {
          id: 902, programId: 2, state: 'scheduled', type: 'event_tournament',
          title: 'PLAYOFFS', start: { date: '2099-02-20', time: '18:30' },
          end: { date: '2099-02-20', time: '23:55' }, teams: [],
        },
        // A second marker, EARLIER than 902, so "tournaments come out
        // sorted" can't pass just because the input happened to be sorted.
        {
          id: 903, programId: 2, state: 'scheduled', type: 'event_tournament',
          title: 'PLAYOFFS', start: { date: '2099-02-13', time: '12:00' }, teams: [],
        },
        // Must be dropped: a past marker and a rescheduled one. Without
        // the gating these would send a player to the playoffs screen on
        // an ordinary league night.
        {
          id: 904, programId: 2, state: 'scheduled', type: 'event_tournament',
          title: 'PLAYOFFS', start: { date: '2001-01-01', time: '18:30' }, teams: [],
        },
        {
          id: 905, programId: 2, state: 'rescheduled', type: 'event_tournament',
          title: 'PLAYOFFS', start: { date: '2099-03-01', time: '18:30' }, teams: [],
        },
      ];
    },
    fetchStandingsHTML: async (id) => `<standings-for-${id}>`,
    parseStandings: (html, id) => [{ position: 1, teamId: 10, teamName: 'Team A', gamesPlayed: 1, wins: 1, losses: 0, ties: 0, points: 2 }],
    fetchRosterHTML: async (programId, teamId) => `<roster-for-${programId}-${teamId}>`,
    parseRoster: (html) => [{ userId: 555, fullName: 'Real Name', isCaptain: true }],
    // Real verified shape of the live GET /locations response.
    fetchLocations: async () => [{
      id: 107614,
      name: 'Third Coast Volleyball',
      SiteID: 32524,
      source: 'admin',
      subLocations: [
        { id: 70288, name: 'Court 1' },
        { id: 70291, name: 'Court 2' },
      ],
    }],
    readJSON: async (path) => reads.get(path) ?? null,
    writeJSON: async (path, data) => writes.set(path, data),
  };

  await runArchive(deps);

  assert.ok(writes.has('docs/data/standings/1.json'), 'completed program still gets standings written');
  assert.ok(writes.has('docs/data/standings/2.json'));
  assert.ok(writes.has('docs/data/activities/2.json'), 'only the active program gets an activities file');
  assert.equal(writes.has('docs/data/activities/1.json'), false);
  const activities2 = writes.get('docs/data/activities/2.json');
  assert.equal(activities2.games.length, 1, 'the played game should be grouped under program 2, not dropped');
  assert.equal(activities2.games[0].activityId, 900);
  assert.ok(writes.has('docs/data/people/555.json'));
  assert.equal(writes.get('docs/data/people/555.json').firstName, 'Real Name'.split(' ')[0]);
  assert.equal(JSON.stringify(writes.get('docs/data/people/555.json')).includes('Real Name'), false);
  const index = writes.get('docs/data/active-teams-index.json');
  assert.ok(index.some((t) => t.programId === 2 && t.teamId === 10));
  assert.equal(index.some((t) => t.programId === 1), false, 'completed programs must not appear in the search index');

  // The team -> people index the site needs to reach a player card at all.
  const roster = writes.get('docs/data/rosters/2-10.json');
  assert.ok(roster, 'an active team gets a roster file');
  assert.deepEqual(roster.players, [{ userId: 555, firstName: 'Real', isCaptain: true }]);
  assert.equal(JSON.stringify(roster).includes('Real Name'), false, 'a roster file must never carry a full name');
  assert.equal(writes.has('docs/data/rosters/1-10.json'), false, 'completed programs get no roster files');

  // Upcoming-game schedule for the "next game" home screen.
  const schedule2 = writes.get('docs/data/schedule/2.json');
  assert.ok(schedule2, 'an active program gets a schedule file');
  assert.equal(schedule2.programId, 2);
  assert.equal(schedule2.games.length, 1, 'only the real scheduled game counts, not the played one');
  assert.equal(schedule2.games[0].activityId, 901);
  assert.equal(schedule2.games[0].date, '2099-01-15');
  assert.equal(schedule2.games[0].courtName, 'Court 2', 'the real venue subLocationId should resolve to its court name');
  assert.equal(writes.has('docs/data/schedule/1.json'), false, 'a completed program gets no schedule file');

  // The program-wide playoff markers, in the SAME schedule file as the
  // games (not a file of their own) -- the site's router reads both
  // together to decide whether tonight is playoff night or game night,
  // so splitting them would mean two fetches to answer one question.
  assert.deepEqual(schedule2.tournaments, [
    { activityId: 903, date: '2099-02-13', time: '12:00', title: 'PLAYOFFS' },
    { activityId: 902, date: '2099-02-20', time: '18:30', title: 'PLAYOFFS' },
  ], 'only the two future, scheduled markers, sorted by date then time');
  assert.equal(
    schedule2.tournaments.some((t) => t.activityId === 904 || t.activityId === 905),
    false,
    'a past marker and a rescheduled marker must never reach the site',
  );
  // Markers are not games and games are not markers: neither collector
  // may pick up the other's activities.
  assert.equal(schedule2.games.some((g) => g.activityId === 902), false);
  assert.equal(schedule2.tournaments.some((t) => t.activityId === 901), false);
});

// A program with no playoff marker at all must still get the key, as an
// empty array. The router does `schedule?.tournaments ?? []`, so a missing
// key would not crash -- but every consumer would then have to know that
// "absent" and "empty" mean the same thing, and the shape of this file
// would silently differ program to program.
test('runArchive writes an empty tournaments array for an active program with no playoff marker', async () => {
  const writes = new Map();
  await runArchive({
    fetchPrograms: async () => [{ id: 7, name: 'Live League', state: 'LIVE' }],
    fetchActivities: async () => [
      {
        id: 910, programId: 7, state: 'scheduled', type: 'game_season',
        start: { date: '2099-01-15', time: '19:00' }, subLocationId: 70291,
        teams: [{ teamId: 10, teamName: 'Team A' }, { teamId: 11, teamName: 'Team B' }],
      },
    ],
    fetchStandingsHTML: async () => '<standings>',
    parseStandings: () => [{ position: 1, teamId: 10, teamName: 'Team A', gamesPlayed: 1, wins: 1, losses: 0, ties: 0, points: 2 }],
    fetchRosterHTML: async () => '<roster>',
    parseRoster: () => [],
    fetchLocations: async () => [{ id: 107614, name: 'V', subLocations: [{ id: 70291, name: 'Court 2' }] }],
    readJSON: async () => null,
    writeJSON: async (path, data) => writes.set(path, data),
  });
  const schedule = writes.get('docs/data/schedule/7.json');
  assert.deepEqual(schedule.tournaments, []);
  assert.equal(schedule.games.length, 1, 'the regular game is untouched by the tournament capture');
});

// The archiver rewrites every standings file on every run; if any field in
// them changed run-to-run without the league's data changing, `git diff
// --quiet` in the workflow would never be clean and the Action would commit
// ~416 files twice a day forever. A wall-clock `updatedAt` used to do
// exactly that.
test('runArchive writes byte-identical standings when nothing about the data changed', async () => {
  const makeDeps = (writes) => ({
    fetchPrograms: async () => [{ id: 1, name: 'Old League', state: 'COMPLETED' }],
    fetchActivities: async () => [],
    fetchStandingsHTML: async (id) => `<standings-for-${id}>`,
    parseStandings: () => [{ position: 1, teamId: 10, teamName: 'Team A', gamesPlayed: 1, wins: 1, losses: 0, ties: 0, points: 2 }],
    fetchRosterHTML: async () => '<roster>',
    parseRoster: () => [],
    fetchLocations: async () => [],
    readJSON: async () => null,
    writeJSON: async (path, data) => writes.set(path, data),
  });
  const first = new Map();
  const second = new Map();
  await runArchive(makeDeps(first));
  await runArchive(makeDeps(second));
  assert.equal(
    JSON.stringify(first.get('docs/data/standings/1.json')),
    JSON.stringify(second.get('docs/data/standings/1.json')),
  );
});
