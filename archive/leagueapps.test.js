import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStandings, parseRoster, redactCaptainName, fetchRosterHTML, courtName, decodeEntities } from './leagueapps.js';

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
// that catches it.
//
// Every example below uses a deliberately fictional name ("Taylor
// Testperson", "Robin Fakeston"): these tests are ABOUT full names, so an
// example must never be a name a real Third Coast player could have. An
// earlier round of these tests claimed its example was invented when it
// had in fact coincidentally reused a real captain's name from one of the
// roster fixtures — hence the obviously-synthetic surnames now.
test('redactCaptainName leaves an already-safe "First L." parenthetical unchanged', () => {
  assert.equal(redactCaptainName('4. Holy Blockamole Infinity (Bryan M.)'), '4. Holy Blockamole Infinity (Bryan M.)');
});

test('redactCaptainName leaves a single-word parenthetical unchanged', () => {
  assert.equal(redactCaptainName('1. Carolina Beach Bumpers (Ashton)'), '1. Carolina Beach Bumpers (Ashton)');
});

test('redactCaptainName truncates a real "First Last" parenthetical down to an initial (synthetic example)', () => {
  assert.equal(redactCaptainName('8. PandaPeople (Taylor Testperson)'), '8. PandaPeople (Taylor T.)');
});

test('redactCaptainName truncates every word after the first for a 3-word name (synthetic example)', () => {
  assert.equal(redactCaptainName('2. Spike Squad (Taylor Van Testperson)'), '2. Spike Squad (Taylor V. T.)');
});

// Real bug found in the final whole-project review: the doubles/coed
// convention names a team after BOTH partners ("5 - First L. & First2 L2."),
// a shape the trailing-parenthetical rule never looked at. It was safe in
// the real dataset only because LeagueApps' own UI happens to pre-abbreviate
// most of them — nothing enforced it, and a real full-catalog sweep with
// this rule in place did turn up one genuine unabbreviated surname.
test('redactCaptainName reduces a full "First Last and First2 Last2" doubles name (synthetic example)', () => {
  assert.equal(
    redactCaptainName('5. Taylor Testperson and Robin Fakeston'),
    '5. Taylor T. and Robin F.',
  );
});

test('redactCaptainName handles the "&" spelling of the same doubles form (synthetic example)', () => {
  assert.equal(
    redactCaptainName('5 - Taylor Testperson & Robin Fakeston'),
    '5 - Taylor T. & Robin F.',
  );
});

test('redactCaptainName redacts only the unabbreviated half of a doubles name (synthetic example)', () => {
  assert.equal(redactCaptainName('4 - Taylor T. & Robin Fakeston'), '4 - Taylor T. & Robin F.');
  assert.equal(redactCaptainName('4 - Taylor Testperson & Robin F.'), '4 - Taylor T. & Robin F.');
});

// The shape 99% of the real dataset already uses: it must come back byte
// for byte, never double-abbreviated ("Taylor T." -> "Taylor T..").
test('redactCaptainName leaves an already-abbreviated doubles name completely untouched', () => {
  for (const safe of [
    '11 - Mili V. & Brian T.',
    '5 - Hannah S. and Trenton P.',
    '2 - David Dry. & Bill K.',
    '6 - Matt Fa. & Mike K.',
    '5 - Susan & Hollis S.',
  ]) {
    assert.equal(redactCaptainName(safe), safe);
  }
});

// Real team names from the live dataset that merely CONTAIN "and"/"&".
// The rule must stand down on these rather than mangling them.
test('redactCaptainName leaves real non-person "and"/"&" team names alone', () => {
  for (const safe of [
    '2 - Beans and Rice (Chris R.)',
    '1 - Beauty and the Beasts (Benet G.)',
    '4 - Net Flicks and Chill (Grace L.)',
    '3 - Dinking & Diving (Stephen R.)',
    '10 - Beaches and Cream (Liz C.)',
    'Bump and Run',
  ]) {
    assert.equal(redactCaptainName(safe), safe);
  }
});

test('parseStandings redacts an unabbreviated doubles name found in a real row (synthetic example)', () => {
  const doc = `<table class="standings">
    <tr><th>Team</th><th>GP</th><th>W</th><th>L</th><th>T</th><th>PS</th></tr>
    <tr><td><a href="/teams/502">5 - Taylor Testperson &amp; Robin Fakeston</a></td><td>5</td><td>4</td><td>1</td><td>0</td><td>100</td></tr>
  </table>`;
  assert.equal(parseStandings(doc, 999)[0].teamName, '5 - Taylor T. & Robin F.');
});

test('redactCaptainName leaves a team name with no trailing parenthetical unchanged', () => {
  assert.equal(redactCaptainName('3. No Captain Suffix'), '3. No Captain Suffix');
});

test('parseStandings redacts a real "First Last" captain name found in a real row (synthetic example)', () => {
  const doc = `<table class="standings">
    <tr><th>Team</th><th>GP</th><th>W</th><th>L</th><th>T</th><th>PS</th></tr>
    <tr><td><a href="/teams/501">8 - PandaPeople (Taylor Testperson)</a></td><td>5</td><td>4</td><td>1</td><td>0</td><td>100</td></tr>
  </table>`;
  const rows = parseStandings(doc, 999);
  assert.equal(rows[0].teamName, '8 - PandaPeople (Taylor T.)');
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


// Real verified shape of the live GET /locations response: a single
// location object whose subLocations is the actual list of courts.
const REAL_LOCATIONS_FIXTURE = [{
  id: 107614,
  name: 'Third Coast Volleyball',
  SiteID: 32524,
  source: 'admin',
  subLocations: [
    { id: 70288, name: 'Court 1' },
    { id: 70291, name: 'Court 2' },
  ],
}];

test('courtName resolves a real subLocationId to its court name', () => {
  assert.equal(courtName(REAL_LOCATIONS_FIXTURE, 70291), 'Court 2');
});

test('courtName returns null for a missing/null subLocationId (court not yet assigned)', () => {
  assert.equal(courtName(REAL_LOCATIONS_FIXTURE, null), null);
  assert.equal(courtName(REAL_LOCATIONS_FIXTURE, undefined), null);
});

test('courtName returns null, not a throw, for an id that does not exist in the data', () => {
  assert.equal(courtName(REAL_LOCATIONS_FIXTURE, 999999), null);
});

// decodeEntities is the same unescaping cellText has always applied to
// scraped HTML, now exported so the JSON API paths (activities/schedule)
// can share it instead of passing entity-encoded names straight through.
test('decodeEntities undoes the entities LeagueApps actually emits', () => {
  assert.equal(decodeEntities('Barrio&#39;s Best'), "Barrio's Best");
  assert.equal(decodeEntities('Nets &amp; Chill'), 'Nets & Chill');
  assert.equal(decodeEntities('The&nbsp;Blockers'), 'The Blockers');
  assert.equal(decodeEntities('&quot;Spike&quot; Squad'), '"Spike" Squad');
  // &amp; is undone first, so a double-encoded apostrophe resolves fully.
  assert.equal(decodeEntities('Barrio&amp;#39;s Best'), "Barrio's Best");
  assert.equal(decodeEntities('Plain Name'), 'Plain Name');
});

// A malformed activity (no teamName field at all) must fail loudly, not get
// archived forever as a team literally named "null" -- the same guard
// parseStandings applies elsewhere rather than guessing on bad data.
test('decodeEntities throws on a null team name instead of returning the string "null"', () => {
  assert.throws(() => decodeEntities(null), /decodeEntities/);
});

test('decodeEntities throws on an undefined team name instead of returning the string "undefined"', () => {
  assert.throws(() => decodeEntities(undefined), /decodeEntities/);
});
