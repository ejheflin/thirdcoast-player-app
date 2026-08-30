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
        id: 900, state: 'played_regular_time', start: { date: '2026-08-30' },
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

  assert.ok(writes.has('data/standings/1.json'), 'completed program still gets standings written');
  assert.ok(writes.has('data/standings/2.json'));
  assert.ok(writes.has('data/activities/2.json'), 'only the active program gets an activities file');
  assert.equal(writes.has('data/activities/1.json'), false);
  assert.ok(writes.has('data/people/555.json'));
  assert.equal(writes.get('data/people/555.json').firstName, 'Real Name'.split(' ')[0]);
  assert.equal(JSON.stringify(writes.get('data/people/555.json')).includes('Real Name'), false);
  const index = writes.get('data/active-teams-index.json');
  assert.ok(index.some((t) => t.programId === 2 && t.teamId === 10));
  assert.equal(index.some((t) => t.programId === 1), false, 'completed programs must not appear in the search index');
});
