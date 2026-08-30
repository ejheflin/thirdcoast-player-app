import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStandings, parseRoster, redactCaptainName, fetchRosterHTML } from './leagueapps.js';

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

// Real bug found in code review after Task 14: a team name's trailing
// "(Captain Name)" is content the captain typed in themselves — most
// write "First L.", but nothing enforces that, and a full "First Last"
// can flow straight into every data file. redactCaptainName is the sweep
// that catches it. Uses an INVENTED synthetic name, not a real one, since
// the whole point is to never let a real full name land in a fixture.
test('redactCaptainName leaves an already-safe "First L." parenthetical unchanged', () => {
  assert.equal(redactCaptainName('4. Holy Blockamole Infinity (Bryan M.)'), '4. Holy Blockamole Infinity (Bryan M.)');
});

test('redactCaptainName leaves a single-word parenthetical unchanged', () => {
  assert.equal(redactCaptainName('1. Carolina Beach Bumpers (Ashton)'), '1. Carolina Beach Bumpers (Ashton)');
});

test('redactCaptainName truncates a real "First Last" parenthetical down to an initial (synthetic example)', () => {
  assert.equal(redactCaptainName('8. PandaPeople (Jimmy Ross)'), '8. PandaPeople (Jimmy R.)');
});

test('redactCaptainName truncates every word after the first for a 3-word name (synthetic example)', () => {
  assert.equal(redactCaptainName('2. Spike Squad (Jimmy Van Ross)'), '2. Spike Squad (Jimmy V. R.)');
});

test('redactCaptainName leaves a team name with no trailing parenthetical unchanged', () => {
  assert.equal(redactCaptainName('3. No Captain Suffix'), '3. No Captain Suffix');
});

test('parseStandings redacts a real "First Last" captain name found in a real row (synthetic example)', () => {
  const doc = `<table class="standings">
    <tr><th>Team</th><th>GP</th><th>W</th><th>L</th><th>T</th><th>PS</th></tr>
    <tr><td><a href="/teams/501">8 - PandaPeople (Jimmy Ross)</a></td><td>5</td><td>4</td><td>1</td><td>0</td><td>100</td></tr>
  </table>`;
  const rows = parseStandings(doc, 999);
  assert.equal(rows[0].teamName, '8 - PandaPeople (Jimmy R.)');
});

// Real bug found in code review after Task 14: fetchRosterHTML was missing
// the same ngmp_2023_iframe_transition=1 query param fetchStandingsHTML
// already required, so it served the React SPA shell (0 real players) for
// every real active team. Verified live at the time, now pinned by a test.
test('fetchRosterHTML requests the URL with ngmp_2023_iframe_transition=1', async () => {
  const realFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, text: async () => '<html></html>' };
  };
  try {
    await fetchRosterHTML(12345, 678);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(requestedUrl, /teamRoster\?teamId=678/);
  assert.match(requestedUrl, /ngmp_2023_iframe_transition=1/);
});

