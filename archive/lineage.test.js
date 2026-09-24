// archive/lineage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeague, buildLineage } from './lineage.js';

test('parseLeague reads day, format and level off a real program name', () => {
  assert.deepEqual(parseLeague('Tuesday Coed 4s BB'), { day: 'Tuesday', format: 'Coed 4s', level: 'BB', rank: 3 });
  assert.equal(parseLeague('Thursday Coed 2s AA').rank, 5);
  assert.equal(parseLeague('Tuesday Coed 4s Upper Rec').level, 'Upper Rec');
  assert.equal(parseLeague('Tuesday Coed 4s Upper Recreational').level, 'Upper Rec');
});

test('parseLeague puts BB above B, per the venue\'s own renames', () => {
  assert.ok(parseLeague('Monday Coed 2s BB').rank > parseLeague('Monday Coed 2s B').rank);
});

test('parseLeague trusts the letter before a "(formerly ...)" note', () => {
  assert.equal(parseLeague('Thursday Coed 2s AA (formerly Comp)').level, 'AA');
  assert.equal(parseLeague('Tuesday Coed 4s B (formerly Intermediate #2)').level, 'B');
  assert.equal(parseLeague('Wednesday Mens 2s A (Comp)').level, 'A');
});

test('parseLeague maps pre-2023 names per league, since the same word meant different levels', () => {
  assert.equal(parseLeague('Tuesday Coed 4s Upper Intermediate').level, 'A');
  assert.equal(parseLeague('Monday Coed 2s Upper Intermediate').level, 'BB');
  assert.equal(parseLeague('Thursday Coed 2s Competitive').level, 'AA');
  assert.equal(parseLeague('Thursday Coed 4s Upper Intermediate'), null, 'no recorded rename: not guessed');
});

test('parseLeague treats a combined B/BB league as between its two rungs', () => {
  assert.equal(parseLeague('Friday Coed 2s B/BB').rank, 2.5);
});

test('parseLeague returns null for side events that are not a ladder', () => {
  assert.equal(parseLeague('Monday Coed 2s B/BB Pop Up'), null);
  assert.equal(parseLeague('Wednesday KOB (B/BB)'), null);
  assert.equal(parseLeague('Monday Coed Snake Draft'), null);
  assert.equal(parseLeague(''), null);
});

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);
const row = (teamId, teamName, extra = {}) => ({ position: 1, teamId, teamName, gamesPlayed: 0, wins: 0, losses: 0, ties: 0, points: 0, ...extra });
const players = (...ids) => ids.map((userId) => ({ userId, firstName: 'X', isCaptain: false }));

function lineageOf(programs, standings, rosters) {
  return buildLineage({
    programs,
    standings: new Map(Object.entries(standings).map(([k, v]) => [Number(k), v])),
    rosters: new Map(Object.entries(rosters)),
  });
}

test('buildLineage marks a demotion and follows a three-season chain', () => {
  const out = lineageOf(
    [
      { id: 1, name: 'Tuesday Coed 4s B', endDate: T0 },
      { id: 2, name: 'Tuesday Coed 4s A', endDate: T0 + 90 * DAY },
      { id: 3, name: 'Tuesday Coed 4s B', endDate: T0 + 180 * DAY },
    ],
    { 1: [row(10, 'X')], 2: [row(20, 'Y')], 3: [row(30, 'Z')] },
    { '1|10': players(1, 2, 3, 4), '2|20': players(1, 2, 3, 4), '3|30': players(1, 2, 3, 5) },
  );
  const t = out.get(3)[30];
  assert.equal(t.move, 'down');
  assert.equal(t.seasons, 3);
  assert.equal(t.from.level, 'A');
  assert.equal(out.get(2)[20].move, 'up');
});

test('buildLineage ignores a league on another night of the SAME season', () => {
  // Same four players, Monday and Tuesday, ending a week apart: those are
  // two concurrent teams, not one team and its previous season.
  const out = lineageOf(
    [
      { id: 1, name: 'Monday Coed 4s B', endDate: T0 },
      { id: 2, name: 'Tuesday Coed 4s A', endDate: T0 + 7 * DAY },
    ],
    { 1: [row(10, 'X')], 2: [row(20, 'X')] },
    { '1|10': players(1, 2, 3, 4), '2|20': players(1, 2, 3, 4) },
  );
  assert.equal(out.get(2)[20].seasons, 1);
  assert.equal(out.get(2)[20].move, null);
});

test('buildLineage needs a roster majority, unless the team name carried over', () => {
  const programs = [
    { id: 1, name: 'Thursday Coed 4s B', endDate: T0 },
    { id: 2, name: 'Thursday Coed 4s B', endDate: T0 + 90 * DAY },
  ];
  const minority = lineageOf(programs,
    { 1: [row(10, 'Old')], 2: [row(20, 'New')] },
    { '1|10': players(1, 2, 3, 4), '2|20': players(1, 7, 8, 9) });
  assert.equal(minority.get(2)[20].seasons, 1, 'one of four returning is not the same team');

  const kept = lineageOf(programs,
    { 1: [row(10, '3 - Net Gains (Sam B.)')], 2: [row(20, 'Net Gains')] },
    { '1|10': players(1, 2, 3, 4), '2|20': players(1, 7, 8, 9) });
  assert.equal(kept.get(2)[20].seasons, 2, 'same name plus a returning player is the same team');
  assert.equal(kept.get(2)[20].move, 'same');
});

test('buildLineage prefers last season on the same night when two prior teams tie', () => {
  const out = lineageOf(
    [
      { id: 1, name: 'Monday Coed 2s BB', endDate: T0 },
      { id: 2, name: 'Tuesday Womens 2s A', endDate: T0 + 3 * DAY },
      { id: 3, name: 'Monday Coed 2s B', endDate: T0 + 90 * DAY },
    ],
    { 1: [row(10, 'M')], 2: [row(20, 'T')], 3: [row(30, 'N')] },
    { '1|10': players(1, 2), '2|20': players(1, 2), '3|30': players(1, 2) },
  );
  assert.equal(out.get(3)[30].from.programId, 1);
  assert.equal(out.get(3)[30].move, 'down');
});

test('buildLineage links to the most recent qualifying season, not the biggest overlap', () => {
  // The real shape that skipped a season: 4 in common with July, 3 with
  // September, both a majority of this 4-person roster.
  const out = lineageOf(
    [
      { id: 1, name: 'Tuesday Coed 4s Upper Rec', endDate: T0 },
      { id: 2, name: 'Tuesday Coed 4s Upper Rec', endDate: T0 + 70 * DAY },
      { id: 3, name: 'Tuesday Coed 4s B', endDate: T0 + 147 * DAY },
    ],
    { 1: [row(10, 'SMoores')], 2: [row(20, "S'Moores")], 3: [row(30, 'Medium-Spicy')] },
    { '1|10': players(1, 2, 3, 4, 5, 6), '2|20': players(2, 3, 4, 5), '3|30': players(1, 2, 3, 4) },
  );
  assert.equal(out.get(3)[30].from.programId, 2);
  assert.equal(out.get(3)[30].seasons, 3);
});

test('buildLineage gives no move across formats', () => {
  const out = lineageOf(
    [
      { id: 1, name: 'Tuesday Coed 4s B', endDate: T0 },
      { id: 2, name: 'Tuesday Coed 2s A', endDate: T0 + 90 * DAY },
    ],
    { 1: [row(10, 'X')], 2: [row(20, 'X')] },
    { '1|10': players(1, 2), '2|20': players(1, 2) },
  );
  assert.equal(out.get(2)[20].seasons, 2);
  assert.equal(out.get(2)[20].move, null);
});
