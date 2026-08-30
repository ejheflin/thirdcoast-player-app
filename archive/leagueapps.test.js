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

// Real edge case found only via a real full-catalog run against live
// LeagueApps (Task 14): old completed leagues, and leagues whose season
// hasn't started yet, render this exact empty-state message instead of a
// table. That's real "no data", not a broken page — it must not crash
// the whole archive run for every other program.
test('parseStandings returns empty array, not a throw, when standings have not been posted', () => {
  const doc = '<div class="mod empty-state"><p><strong>Sorry</strong>, the standings have not yet been posted.</p></div>';
  assert.deepEqual(parseStandings(doc, 999), []);
});

test('parseStandings returns empty array for a different real empty-state wording (season not started yet)', () => {
  const doc = '<div class="mod empty-state"><p><strong>Sorry</strong>, this league\'s standings are not yet available.</p></div>';
  assert.deepEqual(parseStandings(doc, 999), []);
});

// Real edge case: some real historical standings tables carry a trailing
// "+/-" (point differential) column past the 6 this project reads.
test('parseStandings tolerates a real trailing extra column (+/-)', () => {
  const doc = `<table class="standings">
    <tr><th>Team</th><th>GP</th><th>W</th><th>L</th><th>T</th><th>PS</th><th>+/-</th></tr>
    <tr><td><a href="/teams/501">Real Team</a></td><td>5</td><td>4</td><td>1</td><td>0</td><td>100</td><td>+20</td></tr>
  </table>`;
  const rows = parseStandings(doc, 999);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].teamName, 'Real Team');
  assert.equal(rows[0].teamId, 501);
  assert.equal(rows[0].wins, 4);
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
