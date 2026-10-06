// archive/ics.js
//
// The iCalendar text itself, and nothing else: no I/O, no knowledge of
// which people exist. fetch.js gathers the games and calls buildCalendar
// once per person, the same division archive/lineage.js already uses.

// The venue. Both constants are deliberately here rather than in the
// data: nothing in docs/data records a timezone or an address, because
// every program this site has ever archived is played in one building.
const VENUE_TZ = 'America/Chicago';
const VENUE_ADDRESS = 'Third Coast Volleyball, 5652 Forney Dr, Houston, TX 77036';
// One slot at this venue is an hour -- the same assumption court.html
// makes to lay out its 18:30/19:30/20:30/21:30 columns.
const SLOT_MINUTES = 60;

const pad = (n) => String(n).padStart(2, '0');

// How far the given instant's wall-clock time in `timeZone` is from UTC.
// Intl is the only thing in Node that knows the DST rules, and reading
// them back out of a formatted string is the standard way to get at them
// without shipping a timezone database.
function zoneOffsetMs(instant, timeZone) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  // Some ICU versions render midnight as hour 24 rather than 0.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second),
  );
  return asIfUTC - instant;
}

// "2026-11-03" + "18:30" -> "20261104T003000Z".
//
// Written as an absolute UTC instant rather than TZID + a hand-rolled
// VTIMEZONE block: correct in every client, no DST rules of our own to
// maintain, and a smaller file. The two-pass correction below handles the
// transition weekends, where the offset at the guessed instant differs
// from the offset at the real one.
//
// A wall-clock time inside the repeated hour of a fall-back night is
// genuinely ambiguous and resolves here to the earlier (daylight)
// instant. Games at this venue start between 18:30 and 21:30, so that
// hour is unreachable; this is documented rather than handled.
export function icsUTC(dateISO, time, timeZone = VENUE_TZ) {
  const [y, mo, d] = String(dateISO).split('-').map(Number);
  const [h, mi] = String(time).split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = zoneOffsetMs(guess, timeZone);
  let utc = guess - first;
  const second = zoneOffsetMs(utc, timeZone);
  if (second !== first) utc = guess - second;
  return utcStamp(new Date(utc));
}

function utcStamp(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

// RFC 5545 §3.3.11. The backslash goes first: escaping it after the
// others would double-escape the backslashes they just introduced.
export function escapeICSText(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// RFC 5545 §3.1: no line may exceed 75 OCTETS, and continuation lines
// begin with a single space. Counted in bytes, not characters, so a
// multi-byte name cannot be split mid-codepoint and arrive as mojibake.
export function foldICSLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const char of String(line)) {
    const size = Buffer.byteLength(char, 'utf8');
    // Continuation lines spend one of their 75 octets on the leading space.
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n');
}

export function buildCalendar({ userId, firstName, games }) {
  const list = games ?? [];
  // The league is named in SUMMARY only when the person is actually in
  // more than one. For the ~85% in a single league it would be noise on
  // every event; for the rest an unlabelled event is genuinely ambiguous.
  const multi = new Set(list.map((g) => g.programId)).size > 1;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Third Coast//Player App//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeICSText(`Third Coast — ${firstName ?? 'Volleyball'}`)}`,
    `X-WR-TIMEZONE:${VENUE_TZ}`,
    // Both spellings: Apple honours REFRESH-INTERVAL, Outlook and others
    // read X-PUBLISHED-TTL. Matched to the archiver's own 12-hour cadence.
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];

  for (const game of list) {
    const start = icsUTC(game.date, game.time);
    const endMs = Date.parse(
      `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`
      + `T${start.slice(9, 11)}:${start.slice(11, 13)}:${start.slice(13, 15)}Z`,
    ) + SLOT_MINUTES * 60000;

    const title = game.opponentName ? `vs ${game.opponentName}` : 'Volleyball';
    const summary = multi && game.programName
      ? `${game.programName} — ${title}`
      : title;

    const details = [game.courtName, game.programName].filter(Boolean).join(' · ');
    const link = game.oppTeamId
      ? `team.html?team=${game.oppTeamId}&program=${game.programId}`
      : null;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${game.activityId}-${userId}@thirdcoast`,
      // Deliberately NOT the current time. See the byte-identical test:
      // a live DTSTAMP would make every feed differ on every archive run.
      `DTSTAMP:${start.slice(0, 8)}T000000Z`,
      `DTSTART:${start}`,
      `DTEND:${utcStamp(new Date(endMs))}`,
      `SUMMARY:${escapeICSText(summary)}`,
      `LOCATION:${escapeICSText(VENUE_ADDRESS)}`,
      `DESCRIPTION:${escapeICSText(link ? `${details}\n${link}` : details)}`,
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldICSLine).join('\r\n')}\r\n`;
}

// Which people get a feed, and what is on it.
//
// Everything here is already in memory when fetch.js calls it -- the same
// maps the schedule files and the court map are built from -- so no
// person's record has to be fetched or read back to decide this.
//
// The captain-suffix strip is duplicated from displayTeamName() in
// docs/assets/app.js, which is a classic browser script with no exports
// that Node cannot import. Restructuring it into a module, or adding a
// build step, are both far outside this feature; ten lines is the cheaper
// mistake. Keep the two in step.
const SEED_PREFIX = /^\s*\d+\s*[.\-–)]\s*/;
const CAPTAIN_SUFFIX = /\s*\([^)]*\)\s*$/;

function cleanTeamName(raw) {
  const stripped = String(raw ?? '').replace(SEED_PREFIX, '').replace(CAPTAIN_SUFFIX, '').trim();
  // Guard the same way app.js does: a parenthetical-only name must not
  // become empty.
  return stripped || String(raw ?? '').trim();
}

export function collectPersonFeeds({
  activePrograms, rostersByTeam, upcomingByProgram, standingsByProgram,
}) {
  const programName = new Map((activePrograms ?? []).map((p) => [p.id, p.name]));
  const feeds = new Map();

  for (const [key, players] of rostersByTeam ?? []) {
    const [programId, teamId] = key.split('|').map(Number);
    // Rosters for finished seasons are in this map too (read back from
    // disk and never re-fetched); only active programs get feeds.
    if (!programName.has(programId)) continue;

    const rows = standingsByProgram?.get(programId) ?? [];
    const games = (upcomingByProgram?.get(programId) ?? [])
      .filter((g) => g.teams.some((t) => t.teamId === teamId))
      .map((g) => {
        const opp = g.teams.find((t) => t.teamId !== teamId);
        const oppRow = opp ? rows.find((r) => r.teamId === opp.teamId) : null;
        return {
          activityId: g.activityId,
          date: g.date,
          time: g.time,
          courtName: g.courtName,
          opponentName: opp ? cleanTeamName(oppRow?.teamName ?? opp.teamName) : null,
          oppTeamId: opp?.teamId ?? null,
          programId,
          programName: programName.get(programId),
        };
      });

    for (const player of players ?? []) {
      if (!feeds.has(player.userId)) {
        feeds.set(player.userId, { firstName: player.firstName, games: [] });
      }
      feeds.get(player.userId).games.push(...games);
    }
  }

  // Chronological across leagues, so a merged feed reads as one season.
  for (const feed of feeds.values()) {
    feed.games.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  }
  return feeds;
}
