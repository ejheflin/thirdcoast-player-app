import test from 'node:test';
import assert from 'node:assert/strict';
import { icsUTC, escapeICSText, foldICSLine, buildCalendar } from './ics.js';

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
  const a = buildCalendar({ userId: 31, firstName: 'Mika', games: [GAME] });
  const b = buildCalendar({ userId: 31, firstName: 'Mika', games: [GAME] });
  assert.equal(a, b);
  assert.ok(/DTSTAMP:\d{8}T\d{6}Z/.test(a), 'DTSTAMP is still present and well-formed');
});

test('buildCalendar escapes a comma-bearing opponent name in SUMMARY', () => {
  const ics = buildCalendar({
    userId: 31, firstName: 'Mika',
    games: [{ ...GAME, opponentName: 'Save a Horse, Dig a Volleyball' }],
  });
  assert.ok(ics.includes('Save a Horse\\, Dig a Volleyball'));
});
