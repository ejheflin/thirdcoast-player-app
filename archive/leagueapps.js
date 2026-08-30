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

export async function fetchStandingsHTML(programId) {
  // ngmp_2023_iframe_transition=1 is required: without it the host serves
  // the SPA shell (no table) instead of the legacy rendered page.
  const url = `${SITE_BASE}/leagues/${programId}/standings?ngmp_2023_iframe_transition=1`;
  const res = await fetch(url, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`fetchStandingsHTML: program ${programId} unexpected status ${res.status}`);
  return res.text();
}

export async function fetchRosterHTML(programId, teamId) {
  const url = `${SITE_BASE}/leagues/${programId}/teamRoster?teamId=${teamId}`;
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

// parseStandings ports leagueapps/standings.go's parseStandings.go 1:1:
// same column assertions, same "a row with a team link must parse or the
// whole call fails" rule, so a real team's seed can never silently shift.
export function parseStandings(doc, programId) {
  const tableMatch = /<table[^>]*class="[^"]*standings[^"]*"[^>]*>([\s\S]*?)<\/table>/.exec(doc);
  if (!tableMatch) {
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
  if (header.length !== WANT_HEADERS.length) {
    throw new Error(`program ${programId}: standings header has ${header.length} columns, want ${WANT_HEADERS.length}`);
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
    if (cells.length !== WANT_HEADERS.length) {
      if (hasTeamLink) throw new Error(`program ${programId}: standings row with a team link has ${cells.length} columns, want ${WANT_HEADERS.length}`);
      continue; // spacer/decorative row
    }
    const nums = cells.slice(1).map(Number);
    if (nums.some((n) => Number.isNaN(n))) {
      if (hasTeamLink) throw new Error(`program ${programId}: standings row for team ${JSON.stringify(cells[0])} has a non-numeric stat cell`);
      continue;
    }
    const tm = TEAM_LINK_RE.exec(r);
    out.push({
      position: out.length + 1,
      teamId: tm ? Number(tm[1]) : 0,
      teamName: cells[0],
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
// archive/fixtures/roster-8022079.html). Each row looks like:
//
//   <tr data-user-id="14668864">
//     <td><div class="player-name-cell">
//       ...
//       <div class="player-name-info">
//         <div class="player-name" data-user-id="14668864">Daphne Dow</div>
//         <div class="player-role" data-user-id="14668864">Captain</div>
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
