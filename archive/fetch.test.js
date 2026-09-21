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

// --- season rollover -------------------------------------------------
//
// The site's saved-team pointer is {programId, teamId} -- scoped to ONE
// season's program. Nothing could tell it that season had ended:
// active-teams-index.json is built out of parsed standings rows, so a
// brand-new UPCOMING program contributes zero entries until LeagueApps
// posts its first standings table (verified live: on 2026-09-19 the whole
// new Tuesday and Monday seasons were LIVE/UPCOMING with rows: 0, so they
// were invisible to the site). programs-index.json is the signal that
// does NOT depend on standings: every LIVE/UPCOMING program, the moment
// LeagueApps lists it, which is what lets a player be rolled forward.
test('runArchive writes programs-index.json: every active program, standings or not', async () => {
  const writes = new Map();
  await runArchive({
    fetchPrograms: async () => [
      { id: 1, name: 'Thursday Coed 2s A', state: 'COMPLETED', endDate: 1757000000000 },
      { id: 2, name: 'Thursday Coed 2s A', state: 'LIVE', endDate: 1767000000000 },
      // The real shape that active-teams-index.json cannot represent: a
      // real, announced next season with no standings posted yet.
      { id: 3, name: 'Tuesday Coed 4s B', state: 'UPCOMING', endDate: 1777000000000 },
    ],
    fetchActivities: async () => [],
    fetchStandingsHTML: async () => '<standings>',
    parseStandings: (html, id) => (id === 3 ? [] : [
      { position: 1, teamId: 10, teamName: 'Team A', gamesPlayed: 1, wins: 1, losses: 0, ties: 0, points: 2 },
    ]),
    fetchRosterHTML: async () => '<roster>',
    parseRoster: () => [],
    fetchLocations: async () => [],
    readJSON: async () => null,
    writeJSON: async (path, data) => writes.set(path, data),
  });

  const programs = writes.get('docs/data/programs-index.json');
  assert.ok(programs, 'every run writes a programs index');
  assert.deepEqual(programs, [
    { programId: 2, programName: 'Thursday Coed 2s A', state: 'LIVE', endDate: 1767000000000 },
    { programId: 3, programName: 'Tuesday Coed 4s B', state: 'UPCOMING', endDate: 1777000000000 },
  ]);
  assert.equal(programs.some((p) => p.programId === 1), false,
    'a completed season must not read as active -- that is exactly what pins a player to a dead season');

  // The gap this file exists to close: program 3 is genuinely active but
  // has no standings, so it appears in NEITHER the team index nor -- until
  // now -- anywhere else the site could see it.
  const teams = writes.get('docs/data/active-teams-index.json');
  assert.equal(teams.some((t) => t.programId === 3), false);
  assert.ok(programs.some((p) => p.programId === 3));
});

// endDate is what orders two seasons of the same league, and LeagueApps
// does not always send it. Missing must be an explicit null, not an absent
// key, for the same reason `tournaments: []` is: one shape per file.
test('runArchive tolerates a program with no endDate', async () => {
  const writes = new Map();
  await runArchive({
    fetchPrograms: async () => [{ id: 4, name: 'Pop Up League', state: 'LIVE' }],
    fetchActivities: async () => [],
    fetchStandingsHTML: async () => '<standings>',
    parseStandings: () => [],
    fetchRosterHTML: async () => '<roster>',
    parseRoster: () => [],
    fetchLocations: async () => [],
    readJSON: async () => null,
    writeJSON: async (path, data) => writes.set(path, data),
  });
  assert.deepEqual(writes.get('docs/data/programs-index.json'), [
    { programId: 4, programName: 'Pop Up League', state: 'LIVE', endDate: null },
  ]);
});

// --- the venue-wide court map ----------------------------------------
//
// Schedules are stored per PROGRAM, but a court map is per NIGHT: on a
// real Tuesday all 12 courts are filled by five different programs at
// once. Re-indexing that client-side would mean fetching every active
// program's schedule (16 files on 2026-09-20) just to draw one floor, so
// the archiver does the merge instead -- it already has every upcoming
// game in memory at this point, so it costs nothing extra.
test('runArchive writes a per-night court map merged across every active program', async () => {
  const writes = new Map();
  const game = (id, programId, court, time, a, b) => ({
    id, programId, state: 'scheduled', type: 'game_season',
    start: { date: '2099-03-10', time }, subLocationId: court,
    teams: [{ teamId: a, teamName: `Team ${a}` }, { teamId: b, teamName: `Team ${b}` }],
  });
  await runArchive({
    fetchPrograms: async () => [
      { id: 10, name: 'Tuesday Coed 4s A', state: 'LIVE' },
      { id: 11, name: 'Tuesday Womens 2s A', state: 'LIVE' },
    ],
    // Two programs, same night, two slots, different courts -- the exact
    // shape the merge exists for.
    fetchActivities: async () => [
      game(1, 10, 70288, '18:30', 100, 101), // Court 1
      game(2, 11, 70291, '18:30', 200, 201), // Court 2
      game(3, 10, 70288, '19:30', 102, 103), // Court 1, later slot
    ],
    fetchStandingsHTML: async () => '<standings>',
    parseStandings: () => [],
    fetchRosterHTML: async () => '<roster>',
    parseRoster: () => [],
    fetchLocations: async () => [{
      id: 1, name: 'Third Coast Volleyball',
      subLocations: [{ id: 70288, name: 'Court 1' }, { id: 70291, name: 'Court 2' }],
    }],
    readJSON: async () => null,
    writeJSON: async (path, data) => writes.set(path, data),
  });

  const night = writes.get('docs/data/courts/2099-03-10.json');
  assert.ok(night, 'a night with games gets a court map');
  assert.equal(night.date, '2099-03-10');
  assert.deepEqual(night.slots.map((s) => s.time), ['18:30', '19:30'], 'slots sorted by time');

  const first = night.slots[0];
  assert.equal(first.courts.length, 2, 'both programs land in the same slot');
  assert.deepEqual(first.courts.map((c) => c.court), [1, 2], 'courts sorted by number');
  // The whole point: two DIFFERENT programs on one floor.
  assert.deepEqual(first.courts.map((c) => c.programName),
    ['Tuesday Coed 4s A', 'Tuesday Womens 2s A']);
  assert.equal(first.courts[0].courtName, 'Court 1');
  assert.deepEqual(first.courts[0].teams.map((t) => t.teamId), [100, 101]);

  assert.equal(night.slots[1].courts.length, 1, 'the later slot has only its own game');
  assert.equal(night.slots[1].courts[0].court, 1);

  // The index is what lets the site pick "tonight, else the next night"
  // without fetching every date.
  assert.deepEqual(writes.get('docs/data/courts/index.json'), { dates: ['2099-03-10'] });
});

// A court map entry is meaningless without a court and a slot to put it
// in. Rather than inventing a placeholder, such a game is left out of the
// map -- it still appears in its own program's schedule file, which is
// what the rest of the site reads.
test('runArchive leaves a game with no court or no time out of the court map', async () => {
  const writes = new Map();
  await runArchive({
    fetchPrograms: async () => [{ id: 12, name: 'Odd League', state: 'LIVE' }],
    fetchActivities: async () => [
      { id: 1, programId: 12, state: 'scheduled', type: 'game_season',
        start: { date: '2099-04-01', time: '18:30' }, subLocationId: 70288,
        teams: [{ teamId: 1, teamName: 'A' }, { teamId: 2, teamName: 'B' }] },
      // court not assigned yet -- a real, normal state early in a season
      { id: 2, programId: 12, state: 'scheduled', type: 'game_season',
        start: { date: '2099-04-01', time: '19:30' }, subLocationId: null,
        teams: [{ teamId: 3, teamName: 'C' }, { teamId: 4, teamName: 'D' }] },
      // no start time at all
      { id: 3, programId: 12, state: 'scheduled', type: 'game_season',
        start: { date: '2099-04-01' }, subLocationId: 70288,
        teams: [{ teamId: 5, teamName: 'E' }, { teamId: 6, teamName: 'F' }] },
    ],
    fetchStandingsHTML: async () => '<standings>',
    parseStandings: () => [],
    fetchRosterHTML: async () => '<roster>',
    parseRoster: () => [],
    fetchLocations: async () => [{ id: 1, name: 'V', subLocations: [{ id: 70288, name: 'Court 1' }] }],
    readJSON: async () => null,
    writeJSON: async (path, data) => writes.set(path, data),
  });
  const night = writes.get('docs/data/courts/2099-04-01.json');
  assert.equal(night.slots.length, 1, 'only the fully-specified game makes the map');
  assert.equal(night.slots[0].time, '18:30');
  assert.equal(night.slots[0].courts.length, 1);
  // ...but it is still in the program's own schedule, not lost.
  const sched = writes.get('docs/data/schedule/12.json');
  assert.equal(sched.games.length, 3, 'all three remain in the program schedule');
});
