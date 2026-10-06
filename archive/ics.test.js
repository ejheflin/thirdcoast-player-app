import test from 'node:test';
import assert from 'node:assert/strict';
import { icsUTC, escapeICSText, foldICSLine, buildCalendar, collectPersonFeeds } from './ics.js';

// --- timezone ---------------------------------------------------------
//
// The venue keeps wall-clock time and nothing in docs/data records a zone,
// so these conversions are the feature's one real correctness risk. All
// four cases are taken from real fixture and schedule dates.

test('icsUTC converts venue wall-clock to UTC across the DST boundary', () => {
  // CDT (UTC-5) in October...
  assert.equal(icsUTC('2026-10-06', '18:30'), '20261006T233000Z');
  // ...and CST (UTC-6) in November, after DST ends on 2026-11-01.
  assert.equal(icsUTC('2026-11-03', '18:30'), '20261104T003000Z');
  // 2027 fixtures: March 1 is still CST, March 15 is CDT (DST starts
  // 2027-03-14), so a naive fixed offset gets one of these wrong.
  assert.equal(icsUTC('2027-03-01', '19:00'), '20270302T010000Z');
  assert.equal(icsUTC('2027-03-15', '20:00'), '20270316T010000Z');
});

test('icsUTC rolls the date forward when the UTC instant crosses midnight', () => {
  assert.equal(icsUTC('2027-03-08', '18:30'), '20270309T003000Z');
});

// --- escaping and folding --------------------------------------------

test('escapeICSText escapes the four RFC 5545 specials', () => {
  // Real roster entry, and the reason this matters at all.
  assert.equal(
    escapeICSText('6. Save a Horse, Dig a Volleyball (Sarah F.)'),
    '6. Save a Horse\\, Dig a Volleyball (Sarah F.)',
  );
  assert.equal(escapeICSText('a;b'), 'a\\;b');
  assert.equal(escapeICSText('a\nb'), 'a\\nb');
  // The backslash must be escaped FIRST, or escaping the others
  // double-escapes their new backslashes.
  assert.equal(escapeICSText('a\\b,c'), 'a\\\\b\\,c');
});

test('foldICSLine folds at 75 octets, counting bytes not characters', () => {
  const folded = foldICSLine('X'.repeat(200));
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1, 'a 200-char line must fold');
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line over 75 octets: ${line.length}`);
  }
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith(' '), 'continuation lines begin with a space');
  }
  assert.equal(folded.split('\r\n').join('').replace(/ /g, ''), 'X'.repeat(200));
});

test('foldICSLine never splits a multi-byte character', () => {
  // An em dash is 3 bytes in UTF-8; folding by character count would
  // slice one in half and produce invalid UTF-8 on the wire.
  const folded = foldICSLine(`SUMMARY:${'—'.repeat(60)}`);
  for (const line of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
    assert.ok(!line.includes('�'), 'no replacement characters');
  }
  assert.equal(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join(''),
    `SUMMARY:${'—'.repeat(60)}`);
});

test('foldICSLine leaves a short line alone', () => {
  assert.equal(foldICSLine('SUMMARY:vs Net Ninjas'), 'SUMMARY:vs Net Ninjas');
});

// --- the calendar -----------------------------------------------------

const GAME = {
  activityId: 9301001,
  date: '2027-03-01',
  time: '19:00',
  courtName: 'Court 3',
  opponentName: 'Monday Mashers',
  programId: 9301,
  programName: 'Identity Monday League',
  oppTeamId: 602,
};

test('buildCalendar emits a well-formed, CRLF-terminated VCALENDAR', () => {
  const ics = buildCalendar({ userId: 31, firstName: 'Mika', games: [GAME] });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.includes('VERSION:2.0\r\n'));
  assert.ok(ics.includes('CALSCALE:GREGORIAN\r\n'));
  assert.ok(ics.includes('METHOD:PUBLISH\r\n'));
  assert.ok(ics.includes('X-WR-TIMEZONE:America/Chicago\r\n'));
  assert.ok(/REFRESH-INTERVAL;VALUE=DURATION:PT12H/.test(ics));
  // Every line ends CRLF and no bare LF survives anywhere.
  assert.equal(ics.split('\n').length - 1, ics.split('\r\n').length - 1);
});

test('buildCalendar writes one timed hour-long event per game', () => {
  const ics = buildCalendar({ userId: 31, firstName: 'Mika', games: [GAME] });
  assert.ok(ics.includes('DTSTART:20270302T010000Z\r\n'));
  assert.ok(ics.includes('DTEND:20270302T020000Z\r\n'), 'a slot is one hour');
  assert.ok(ics.includes('UID:9301001-31@thirdcoast\r\n'));
  assert.ok(ics.includes('SUMMARY:vs Monday Mashers\r\n'));
  assert.ok(ics.includes('5652 Forney Dr'), 'LOCATION carries the street address');
  assert.ok(ics.includes('Court 3'), 'DESCRIPTION names the court');
});

test('buildCalendar prefixes the league ONLY when the person is in several', () => {
  const one = buildCalendar({ userId: 31, firstName: 'Mika', games: [GAME] });
  assert.ok(!one.includes('Identity Monday League — vs'), 'no prefix for a single league');

  const other = {
    ...GAME, activityId: 9302001, date: '2027-03-08', time: '18:30',
    programId: 9302, programName: 'Identity Thursday League',
    opponentName: 'Late Night Lobs', oppTeamId: 612,
  };
  const two = buildCalendar({ userId: 31, firstName: 'Mika', games: [GAME, other] });
  assert.ok(two.includes('SUMMARY:Identity Monday League — vs Monday Mashers\r\n'));
  assert.ok(two.includes('SUMMARY:Identity Thursday League — vs Late Night Lobs\r\n'));
  // Pins the DERIVATION, not one date's value: a second game on a
  // different date must get a different DTSTAMP, matching its own
  // UTC start date. A single hardcoded constant would pass the literal
  // assertion in the byte-identical test below but fail this one.
  assert.ok(two.includes('DTSTAMP:20270302T000000Z'), 'DTSTAMP for the 2027-03-01 game');
  assert.ok(two.includes('DTSTAMP:20270309T000000Z'), 'DTSTAMP for the 2027-03-08 game');
});

test('buildCalendar falls back to Volleyball when the opponent is unassigned', () => {
  const ics = buildCalendar({
    userId: 31, firstName: 'Mika',
    games: [{ ...GAME, opponentName: null, oppTeamId: null }],
  });
  assert.ok(ics.includes('SUMMARY:Volleyball\r\n'));
  assert.ok(!ics.includes('vs null'));
});

test('buildCalendar yields a valid EMPTY calendar for a person with no games', () => {
  // Load-bearing: this is what a retired feed is rewritten to, so an old
  // subscription goes quiet instead of 404ing and being disabled.
  const ics = buildCalendar({ userId: 41, firstName: 'Dormant', games: [] });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!ics.includes('BEGIN:VEVENT'));
});

test('buildCalendar output is byte-identical across two calls', () => {
  // The regression guard on the deterministic-DTSTAMP decision. A live
  // timestamp would make all ~259 files differ on every archive run, so
  // the archiver would commit 259 changed files twice a day forever into
  // a repo that is also the published website.
  //
  // The a === b check alone cannot catch a `new Date()` regression: both
  // calls happen within the same second, so a clock-read DTSTAMP formatted
  // to seconds resolution would agree with itself here and this test would
  // pass anyway. The literal assertion below is what actually has bite --
  // it pins DTSTAMP to the value derived from the game's own date
  // (2027-03-01 local, which is 2027-03-02 once converted to its UTC
  // start), which a clock read would not produce.
  const a = buildCalendar({ userId: 31, firstName: 'Mika', games: [GAME] });
  const b = buildCalendar({ userId: 31, firstName: 'Mika', games: [GAME] });
  assert.equal(a, b);
  assert.ok(/DTSTAMP:\d{8}T\d{6}Z/.test(a), 'DTSTAMP is still present and well-formed');
  assert.ok(a.includes('DTSTAMP:20270302T000000Z'), 'DTSTAMP is derived from the game date, not read from the clock');
});

test('buildCalendar escapes a comma-bearing opponent name in SUMMARY', () => {
  const ics = buildCalendar({
    userId: 31, firstName: 'Mika',
    games: [{ ...GAME, opponentName: 'Save a Horse, Dig a Volleyball' }],
  });
  assert.ok(ics.includes('Save a Horse\\, Dig a Volleyball'));
});

// --- collectPersonFeeds -------------------------------------------------

// Mirrors the real in-memory shapes at the point fetch.js calls this.
const COLLECT_DEPS = () => ({
  activePrograms: [
    { id: 9301, name: 'Identity Monday League' },
    { id: 9302, name: 'Identity Thursday League' },
  ],
  rostersByTeam: new Map([
    ['9301|601', [
      { userId: 31, firstName: 'Mika', isCaptain: true },
      { userId: 32, firstName: 'Oren', isCaptain: false },
    ]],
    ['9302|611', [{ userId: 31, firstName: 'Mika', isCaptain: false }]],
  ]),
  upcomingByProgram: new Map([
    [9301, [{
      activityId: 9301001, date: '2027-03-01', time: '19:00', courtName: 'Court 3',
      teams: [
        { teamId: 601, teamName: '1. Dual Leaguers' },
        { teamId: 602, teamName: '2. Monday Mashers' },
      ],
    }]],
    [9302, [{
      activityId: 9302001, date: '2027-03-08', time: '18:30', courtName: 'Court 7',
      teams: [
        { teamId: 611, teamName: '3. Thursday Thunder' },
        { teamId: 612, teamName: '5. Late Night Lobs' },
      ],
    }]],
  ]),
  standingsByProgram: new Map([
    [9301, [{ teamId: 601, teamName: '1. Dual Leaguers' }, { teamId: 602, teamName: '2. Monday Mashers' }]],
    [9302, [{ teamId: 611, teamName: '3. Thursday Thunder' }, { teamId: 612, teamName: '5. Late Night Lobs' }]],
  ]),
});

test('collectPersonFeeds merges every league a person is in', () => {
  const feeds = collectPersonFeeds(COLLECT_DEPS());
  const mika = feeds.get(31);
  assert.equal(mika.firstName, 'Mika');
  assert.equal(mika.games.length, 2, 'both leagues');
  assert.deepEqual(mika.games.map((g) => g.programId).sort(), [9301, 9302]);
});

test('collectPersonFeeds gives a one-league person only their own games', () => {
  const oren = collectPersonFeeds(COLLECT_DEPS()).get(32);
  assert.equal(oren.games.length, 1);
  assert.equal(oren.games[0].programId, 9301);
});

test('collectPersonFeeds names the opponent, not the player\'s own team', () => {
  const game = collectPersonFeeds(COLLECT_DEPS()).get(31).games
    .find((g) => g.programId === 9301);
  // Seed number and captain suffix both stripped, as every screen does.
  assert.equal(game.opponentName, 'Monday Mashers');
  assert.equal(game.oppTeamId, 602);
});

test('collectPersonFeeds sorts a person\'s games by date then time', () => {
  const games = collectPersonFeeds(COLLECT_DEPS()).get(31).games;
  const keys = games.map((g) => `${g.date}${g.time}`);
  assert.deepEqual(keys, [...keys].sort(), 'chronological across leagues');
});

test('collectPersonFeeds yields an entry with no games rather than skipping', () => {
  // A player on an active roster whose program has no upcoming games left
  // must still get a (valid, empty) feed, not be dropped from the ledger.
  const deps = COLLECT_DEPS();
  deps.upcomingByProgram = new Map();
  const feeds = collectPersonFeeds(deps);
  assert.ok(feeds.has(31));
  assert.deepEqual(feeds.get(31).games, []);
});

test('collectPersonFeeds ignores rosters of programs that are not active', () => {
  const deps = COLLECT_DEPS();
  deps.rostersByTeam.set('1122541|2362435', [{ userId: 999, firstName: 'Ancient' }]);
  assert.ok(!collectPersonFeeds(deps).has(999));
});
