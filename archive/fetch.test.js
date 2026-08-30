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
      return [{
        id: 900, programId: 2, state: 'played_regular_time', start: { date: '2026-08-30' },
        teams: [
          { teamId: 10, teamName: 'Team A', result: 'win', score: 2 },
          { teamId: 11, teamName: 'Team B', result: 'loss', score: 0 },
        ],
      }];
    },
    fetchStandingsHTML: async (id) => `<standings-for-${id}>`,
    parseStandings: (html, id) => [{ position: 1, teamId: 10, teamName: 'Team A', gamesPlayed: 1, wins: 1, losses: 0, ties: 0, points: 2 }],
    fetchRosterHTML: async (programId, teamId) => `<roster-for-${programId}-${teamId}>`,
    parseRoster: (html) => [{ userId: 555, fullName: 'Real Name', isCaptain: true }],
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
