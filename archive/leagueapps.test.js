import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStandings, parseRoster } from './leagueapps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

test('parseStandings reads real Tuesday Coed 4s B standings', () => {
  const rows = parseStandings(fixture('standings-5056676.html'), 5056676);
  assert.ok(rows.length > 0, 'expected at least one row');
  assert.equal(rows[0].position, 1);
  const beachBunnies = rows.find((r) => r.teamName.includes('Beach Bunnies'));
  assert.ok(beachBunnies, 'Beach Bunnies should be in the standings');
  assert.ok(beachBunnies.gamesPlayed > 0);
  assert.equal(typeof beachBunnies.teamId, 'number');
});

test('parseStandings throws on a table with no standings class (SPA shell)', () => {
  assert.throws(() => parseStandings('<html><body>no table here</body></html>', 999));
});

test('parseRoster reads real Volley Llamas roster, finds the captain', () => {
  const players = parseRoster(fixture('roster-8022079.html'));
  assert.ok(players.length >= 4, 'expected at least 4 real players');
  const daphne = players.find((p) => p.fullName === 'Daphne Dow');
  assert.ok(daphne, 'Daphne Dow should be parsed');
  assert.equal(daphne.isCaptain, true);
  assert.equal(typeof daphne.userId, 'number');
  const connor = players.find((p) => p.fullName === 'Connor Koch');
  assert.ok(connor, 'Connor Koch should be parsed');
  assert.equal(connor.isCaptain, false);
});

test('parseRoster reads the Beach Bunnies roster too (a different program)', () => {
  const players = parseRoster(fixture('roster-beachbunnies.html'));
  assert.ok(players.length >= 1);
});

test('parseRoster returns empty array, not a throw, on a page with no roster rows', () => {
  assert.deepEqual(parseRoster('<html><body>nothing here</body></html>'), []);
});
