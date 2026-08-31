// archive/leagueapps.js
//
// A read-only client for LeagueApps' public, unauthenticated endpoints.
// Ported from the existing Go client (thirdcoast_brackets/leagueapps/),
// standalone — no dependency on that repo or its code. Contains no
// volleyball/tournament logic, only HTTP-in, structs-out.

const SUBDOMAIN = 'thirdcoastvolleyball';
const API_BASE = `https://api.leagueapps.io/api/member-portal/${SUBDOMAIN}/siteLevelCalendar`;
const SITE_BASE = `https://${SUBDOMAIN}.leagueapps.com`;

export async function fetchPrograms() {
  const res = await fetch(`${API_BASE}/programs`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`fetchPrograms: unexpected status ${res.status}`);
  return res.json();
}

// programIds must be plural/comma-separated even for one ID — the
// singular form 500s on the real API (verified in the Go client).
export async function fetchActivities(programIds) {
  if (programIds.length === 0) return [];
  const url = `${API_BASE}/scheduleBFF/activities?programIds=${programIds.join(',')}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`fetchActivities: unexpected status ${res.status}`);
  const envelopes = await res.json();
  return envelopes.map((e) => e.activity);
}

export async function fetchLocations() {
  const res = await fetch(`${API_BASE}/locations`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`fetchLocations: unexpected status ${res.status}`);
  return res.json();
}

// Flattens every location's subLocations into a lookup and returns the
// matching name, or null if subLocationId is null/undefined/not found. A
// scheduled game's court isn't always assigned yet, so this must degrade
// gracefully rather than throw.
export function courtName(locations, subLocationId) {
  if (subLocationId === null || subLocationId === undefined) return null;
  for (const location of locations) {
    const sub = location.subLocations?.find((s) => s.id === subLocationId);
    if (sub) return sub.name;
  }
  return null;
}

export async function fetchStandingsHTML(programId) {
  // ngmp_2023_iframe_transition=1 is required: without it the host serves
  // the SPA shell (no table) instead of the legacy rendered page.
  const url = `${SITE_BASE}/leagues/${programId}/standings?ngmp_2023_iframe_transition=1`;
  const res = await fetch(url, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`fetchStandingsHTML: program ${programId} unexpected status ${res.status}`);
  return res.text();
}

export async function fetchRosterHTML(programId, teamId) {
  // Same ngmp_2023_iframe_transition=1 requirement as the standings page —
  // found only via a real live run (Task 14): without it, this endpoint
  // serves the React SPA shell (no roster rows at all) instead of the
  // legacy rendered page every real active team actually needs.
  const url = `${SITE_BASE}/leagues/${programId}/teamRoster?teamId=${teamId}&ngmp_2023_iframe_transition=1`;
  const res = await fetch(url, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`fetchRosterHTML: program ${programId} team ${teamId} unexpected status ${res.status}`);
  return res.text();
}

function cellText(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function cellsOf(row) {
  const out = [];
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
  let m;
  while ((m = cellRe.exec(row))) out.push(cellText(m[1]));
  return out;
}

const WANT_HEADERS = ['Team', 'GP', 'W', 'L', 'T', 'PS'];
const TEAM_LINK_RE = /\/teams\/(\d+)/;

// ---------------------------------------------------------------------
// Captain-name redaction.
//
// A team name is public LeagueApps content a captain typed in themselves,
// and it is the one place a real full name can flow into this repo. Two
// real shapes carry one:
//
//   1. a trailing parenthetical  -- "Holy Blockamole (Bryan Miller)"
//   2. an "and"/"&"-joined pair  -- "5 - Michael Gray & Daniel Ashe"
//      (the doubles/coed convention: the two partners name the team)
//
// Most captains already write "First L." in both shapes, but nothing on
// LeagueApps' side enforces that. This project's core guarantee is that a
// full surname is never persisted anywhere, so every team name is swept
// through here before it is ever written to disk.
//
// Both rules are deliberately conservative: they only fire on text that
// already looks like a person's name, so a team called "Beans and Rice"
// or "Net Flicks and Chill (Grace L.)" is left exactly as its captain
// wrote it. Verified by replaying both rules over all 2,962 distinct team
// names in a real full-catalog archive: exactly one name changed, and it
// was a genuine unabbreviated surname.
//
// Accepted trade-off, deliberately biased toward privacy: rule 2 cannot
// tell "Hannah Smith and Trenton" from a hypothetical joke name shaped
// like "Peanut Butter and Jelly", so it would abbreviate the latter to
// "Peanut B. and Jelly". No such name exists anywhere in the real
// dataset, and mangling a joke team name is a far cheaper mistake than
// publishing a real person's surname.

// "G." / "Fa." / "Dry." -- a real captain's already-abbreviated surname.
const ABBREVIATED_WORD = /^[A-Z][A-Za-z]{0,2}\.$/;
// "Michael" / "O'Brien" / "Smith-Jones" -- a whole, unabbreviated word.
const FULL_WORD = /^[A-Z][A-Za-z'’-]+$/;

function isFullWord(w) {
  return FULL_WORD.test(w) && !ABBREVIATED_WORD.test(w);
}

function abbreviate(word) {
  return `${word[0].toUpperCase()}.`;
}

// Rule 1: a trailing "(...)". Already "First L." (or a single word) is
// left alone; two or more full words get every word after the first
// truncated to its initial.
function redactTrailingParenthetical(teamName) {
  const m = /\(([^)]+)\)\s*$/.exec(teamName);
  if (!m) return teamName;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  const alreadySafe = words.length <= 1 || (words.length === 2 && /^[A-Z]\.$/.test(words[1]));
  if (alreadySafe) return teamName;
  const redactedInner = [words[0], ...words.slice(1).map((w) => abbreviate(w))].join(' ');
  return `${teamName.slice(0, m.index)}(${redactedInner})`;
}

// Classifies one side of an "X and Y" join:
//   'safe'   -- "Hannah" or "Hannah S." : nothing to redact
//   'unsafe' -- "Hannah Smith"          : a full surname, must be cut down
//   null     -- anything else ("the Beasts", "Net Flicks and Chill") :
//               not a person's name at all, so the whole rule stands down.
function classifyNameSide(side) {
  const words = side.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1 && isFullWord(words[0])) return 'safe';
  if (words.length === 2 && isFullWord(words[0]) && ABBREVIATED_WORD.test(words[1])) return 'safe';
  if (words.length === 2 && isFullWord(words[0]) && isFullWord(words[1])) return 'unsafe';
  return null;
}

// A leading league-assigned seed number: "5 - ", "5. ", "12) ".
const SEED_PREFIX_RE = /^(\s*\d+\s*[.\-–)]\s*)/;
const JOINED_RE = /^(.*?)(\s+(?:and|&)\s+)(.*)$/i;

// Rule 2: "First Last and First2 Last2" (or "&"). Fires only when BOTH
// sides read as a person's name and at least one of them still carries an
// unabbreviated surname -- so an already-safe "Mili V. & Brian T." comes
// back untouched rather than double-abbreviated.
function redactJoinedNames(teamName) {
  // A trailing parenthetical means the captain is identified there, not by
  // the joined phrase before it ("Big Digs and Tiff (Mike B.)"). Rule 1
  // owns that shape.
  if (/\([^)]*\)\s*$/.test(teamName)) return teamName;
  const prefix = SEED_PREFIX_RE.exec(teamName)?.[1] ?? '';
  const m = JOINED_RE.exec(teamName.slice(prefix.length));
  if (!m) return teamName;
  const [, left, joiner, right] = m;
  const leftKind = classifyNameSide(left);
  const rightKind = classifyNameSide(right);
  if (!leftKind || !rightKind) return teamName;
  if (leftKind !== 'unsafe' && rightKind !== 'unsafe') return teamName;
  const cut = (side) => {
    const words = side.trim().split(/\s+/);
    return `${words[0]} ${abbreviate(words[1])}`;
  };
  const l = leftKind === 'unsafe' ? cut(left) : left.trim();
  const r = rightKind === 'unsafe' ? cut(right) : right.trim();
  return `${prefix}${l}${joiner}${r}`;
}

export function redactCaptainName(teamName) {
  const parenthetical = redactTrailingParenthetical(teamName);
  if (parenthetical !== teamName) return parenthetical;
  return redactJoinedNames(teamName);
}

// A real, sanctioned LeagueApps empty-state, seen on real completed
// programs (long-past leagues whose standings were simply never posted)
// and real not-yet-started upcoming programs (no games played yet). This
// is "no data", not "the page shape changed" — parseRoster already draws
// the same distinction (empty roster vs. malformed page), so standings
// gets the same treatment here rather than crashing the whole archive run.
// Matched structurally (the stable "mod empty-state" wrapper LeagueApps
// renders on the standings page whenever there's nothing to show) rather
// than by exact wording, since a real full-catalog run turned up multiple
// real wordings for it ("the standings have not yet been posted.",
// "this league's standings are not yet available.").
const NOT_POSTED_RE = /class="mod empty-state"/i;

// parseStandings ports leagueapps/standings.go's parseStandings.go 1:1:
// same column assertions, same "a row with a team link must parse or the
// whole call fails" rule, so a real team's seed can never silently shift.
// One relaxation found only via a real full-catalog run (see Task 14):
// some real historical standings tables carry a trailing "+/-" column
// past the expected 6. Extra trailing columns are tolerated as long as
// the first WANT_HEADERS.length columns match exactly, in order — the
// "can never silently shift" guarantee is unaffected since the columns
// this project actually reads are still asserted by name and position.
export function parseStandings(doc, programId) {
  const tableMatch = /<table[^>]*class="[^"]*standings[^"]*"[^>]*>([\s\S]*?)<\/table>/.exec(doc);
  if (!tableMatch) {
    if (NOT_POSTED_RE.test(doc)) return [];
    throw new Error(`program ${programId}: no standings table found (page may be the SPA shell)`);
  }
  if (tableMatch[1].includes('<table')) {
    throw new Error(`program ${programId}: standings table contains a nested <table>; refusing a truncated capture`);
  }
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const rows = [];
  let rm;
  while ((rm = rowRe.exec(tableMatch[1]))) rows.push(rm[1]);
  if (rows.length === 0) throw new Error(`program ${programId}: standings table has no rows`);

  const header = cellsOf(rows[0]);
  if (header.length < WANT_HEADERS.length) {
    throw new Error(`program ${programId}: standings header has ${header.length} columns, want at least ${WANT_HEADERS.length}`);
  }
  for (let i = 0; i < WANT_HEADERS.length; i++) {
    if (header[i] !== WANT_HEADERS[i]) {
      throw new Error(`program ${programId}: standings column ${i} is ${JSON.stringify(header[i])}, want ${JSON.stringify(WANT_HEADERS[i])}`);
    }
  }

  const out = [];
  for (const r of rows.slice(1)) {
    const hasTeamLink = TEAM_LINK_RE.test(r);
    const cells = cellsOf(r);
    if (cells.length < WANT_HEADERS.length) {
      if (hasTeamLink) throw new Error(`program ${programId}: standings row with a team link has ${cells.length} columns, want at least ${WANT_HEADERS.length}`);
      continue; // spacer/decorative row
    }
    const nums = cells.slice(1, WANT_HEADERS.length).map(Number);
    if (nums.some((n) => Number.isNaN(n))) {
      if (hasTeamLink) throw new Error(`program ${programId}: standings row for team ${JSON.stringify(cells[0])} has a non-numeric stat cell`);
      continue;
    }
    const tm = TEAM_LINK_RE.exec(r);
    out.push({
      position: out.length + 1,
      teamId: tm ? Number(tm[1]) : 0,
      teamName: redactCaptainName(cells[0]),
      gamesPlayed: nums[0],
      wins: nums[1],
      losses: nums[2],
      ties: nums[3],
      points: nums[4],
    });
  }
  if (out.length === 0) throw new Error(`program ${programId}: standings table parsed to zero teams`);
  return out;
}

// parseRoster reads the real per-player rows LeagueApps renders server-side
// on the teamRoster page (verified against a real captured page — see
// archive/fixtures/roster-8022079.html). The row shape below is the real
// markup with a synthetic stand-in name and id, so no real person's full
// name is quoted here:
//
//   <tr data-user-id="10000001">
//     <td><div class="player-name-cell">
//       ...
//       <div class="player-name-info">
//         <div class="player-name" data-user-id="10000001">Taylor Testperson</div>
//         <div class="player-role" data-user-id="10000001">Captain</div>
//       </div>
//     </div></td>
//     ...
//   </tr>
//
// The player-role div is only present for the captain — its absence means
// isCaptain: false, not an error. A page with no roster rows at all (an
// empty team) returns [], not a thrown error, since "no one registered
// yet" is a normal, expected state, unlike a malformed standings table.
export function parseRoster(doc) {
  const rowRe = /<tr data-user-id="(\d+)">([\s\S]*?)<\/tr>/g;
  const out = [];
  let m;
  while ((m = rowRe.exec(doc))) {
    const userId = Number(m[1]);
    const block = m[2];
    const nameMatch = new RegExp(`<div class="player-name" data-user-id="${userId}">\\s*([\\s\\S]*?)\\s*<\\/div>`).exec(block);
    if (!nameMatch) continue;
    const fullName = cellText(nameMatch[1]);
    if (!fullName) continue;
    const isCaptain = new RegExp(`<div class="player-role" data-user-id="${userId}">Captain<\\/div>`).test(block);
    out.push({ userId, fullName, isCaptain });
  }
  return out;
}
