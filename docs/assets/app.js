// docs/assets/app.js — shared across every page. No framework, no build
// step: every page loads this with a plain <script src="assets/app.js">.

async function injectIcons() {
  const res = await fetch('assets/icons.html');
  const svgText = await res.text();
  const div = document.createElement('div');
  div.innerHTML = svgText;
  document.body.prepend(...div.childNodes);
}

const TEAM_KEY = 'thirdcoast-my-team';

function getMyTeam() {
  try {
    const raw = localStorage.getItem(TEAM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setMyTeam(team) {
  localStorage.setItem(TEAM_KEY, JSON.stringify(team));
}

function clearMyTeam() {
  localStorage.removeItem(TEAM_KEY);
}

// fetchJSON never throws on a 404 -- "no data yet" is a normal state for
// a program the archiver hasn't reached, not an error (see spec's Error
// handling section).
async function fetchJSON(path) {
  const res = await fetch(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchJSON ${path}: unexpected status ${res.status}`);
  return res.json();
}

// Escape user-controlled strings before inserting into innerHTML to prevent XSS.
// Team and program names come from LeagueApps and are not sanitized, so they must
// be escaped whenever inserted into the DOM via innerHTML.
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// A real team name carries up to two self-typed artifacts LeagueApps never
// strips: a leading seed-ish number ("1 - ", "1. ") and, on ~44% of real
// teams, a trailing captain parenthetical ("(Matt O.)"). Both are
// display-only cleanups -- the raw teamName in docs/data/ is never
// touched, and archive/leagueapps.js's own privacy redaction (which
// abbreviates, never removes, the name inside the parenthetical) is
// untouched too.
//
// The leading number is stripped unconditionally: nothing that calls this
// has any real use for a captain's self-assigned number, and everywhere
// it matters a REAL rank/position is already shown separately (rankings'
// .pos column, team.html's stat grid).
//
// The trailing captain name is stripped only when stripCaptain is true --
// it's only actually redundant where a roster with the captain flagged is
// shown on the same page (the match card, team.html's header). On a bare
// list like rankings.html there's no roster to make it redundant against,
// so that caller leaves it in place.
function displayTeamName(rawName, { stripCaptain = false } = {}) {
  let name = String(rawName ?? '');
  const withoutSeed = name.replace(/^\s*\d+\s*[.\-–)]\s*/, '');
  if (withoutSeed.trim()) name = withoutSeed;
  if (stripCaptain) {
    const m = /\(([^)]+)\)\s*$/.exec(name);
    if (m) {
      const before = name.slice(0, m.index).trim();
      if (before) name = before;
    }
  }
  return name;
}

// ---------------------------------------------------------------------
// Season rollover.
//
// The saved-team pointer is {programId, teamId} -- scoped to ONE season's
// program. LeagueApps starts a brand-new program for each new season, with
// new team ids, so when a season ends that pointer silently goes dead.
//
// Nothing used to notice. gamenight.html's stale-pointer branch needs BOTH
// no standings row AND no archived game, but archive/fetch.js writes
// docs/data/standings/{programId}.json for EVERY program, active or not --
// the isActive check comes after that write. So a finished season's
// standings file lives on forever with a full row for the player's team,
// that branch can never fire, and the player sits on "No game scheduled
// right now" for the rest of time while their real new season plays out
// under a different program id.
//
// programs-index.json (written every archive run) is the fix's foundation:
// the authoritative list of LIVE/UPCOMING programs. Deliberately NOT
// active-teams-index.json, which is derived from parsed standings rows and
// is therefore empty for a season LeagueApps has announced but not yet
// posted standings for -- a real, weeks-long window.

let _programsIndex = null;
async function fetchActivePrograms() {
  if (_programsIndex === null) _programsIndex = (await fetchJSON('data/programs-index.json')) ?? [];
  return _programsIndex;
}

// The successor LEAGUE, which is a far more reliable thing to find than
// the successor TEAM: program names are stable verbatim across seasons
// ("Thursday Coed 2s A" -> "Thursday Coed 2s A"), while team names are
// captain-typed and routinely change ("Blake's Beaches" -> "Crab").
// Latest endDate wins, because a league can legitimately have two active
// programs at once -- the real live shape on 2026-09-19 was Monday Coed 2s
// B running its playoffs (LIVE) while next season's Monday Coed 2s B was
// already listed (UPCOMING).
function successorLeague(programs, programName) {
  const same = programs.filter((p) => p.programName === programName);
  if (same.length === 0) return null;
  return same.reduce((best, p) => ((p.endDate ?? 0) > (best.endDate ?? 0) ? p : best));
}

// The successor TEAM, by voting the old roster's players into whatever
// active team they play on now. people/{userId}.json already carries
// appearances across every program a person has ever been on -- it was
// built to survive exactly this -- so no new archived data is needed.
//
// Voting beats name-matching by a wide margin. Replayed over the 66 real
// teams in the four seasons that had just rolled over on 2026-09-19, it
// followed renames that plain name comparison misses outright: "Blake's
// Beaches" -> "Crab", "Nothing But Tape!!" -> "Injured Reserve!",
// "Nathan G. and Zach B." -> "Nate G. and Zach B.".
//
// It is still only a guess -- about a third of real teams come back with
// a partial roster (one half of a 2s pair returning with a new partner is
// genuinely ambiguous, not a solvable matching problem) -- which is why
// the caller CONFIRMS rather than switching silently.
function rankSuccessorTeams(saved, programs, peopleRecords) {
  // Keyed by String, like every other program-id comparison in this file:
  // these ids cross a JSON boundary and a saved pointer can predate any
  // given archiver version, so nothing here assumes they are numbers.
  const byId = new Map(programs.map((p) => [String(p.programId), p]));
  const tally = new Map();
  for (const rec of peopleRecords) {
    // One vote per PERSON per team, not per appearance: a person with two
    // appearances on the same team must not outvote a teammate.
    const seen = new Set();
    for (const a of rec?.appearances ?? []) {
      if (String(a.programId) === String(saved.programId)) continue;
      const program = byId.get(String(a.programId));
      if (!program) continue; // not an active program -- another dead season
      const key = `${a.programId}|${a.teamId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = tally.get(key) ?? {
        programId: a.programId,
        teamId: a.teamId,
        teamName: a.teamName,
        programName: program.programName,
        votes: 0,
      };
      entry.votes += 1;
      tally.set(key, entry);
    }
  }
  const sameLeague = (c) => (c.programName === saved.programName ? 1 : 0);
  return [...tally.values()].sort((a, b) =>
    b.votes - a.votes || sameLeague(b) - sameLeague(a));
}

// A guess is only offered when a MAJORITY of the old roster turned up on
// the same team and no other team tied it. Below that bar the honest
// answer is a picker, not a worse guess -- see the Tuesday case on
// 2026-09-19, where the new season existed but had no rosters yet and
// every "match" was one player who happened to also play on a Monday team.
function isConfidentSuccessor(candidates, rosterSize) {
  const [best, second] = candidates;
  if (!best || rosterSize === 0) return false;
  if (best.votes * 2 <= rosterSize) return false;
  return !second || best.votes > second.votes;
}

// The one question every entry point asks: is this saved team still on a
// season that is actually happening, and if not, what should we offer?
//
//   current  -- nothing to do, the saved season is live
//   rolled   -- confident guess at their new team, pending confirmation
//   pick     -- new season of the same league is running; pick a team
//   waiting  -- new season exists but has no teams posted yet
//   gone     -- season over, no successor league listed at all
//   unknown  -- no programs index (an old deploy): never strand anyone
async function resolveSeason(saved) {
  const programs = await fetchActivePrograms();
  if (programs.length === 0) return { status: 'unknown' };
  if (programs.some((p) => String(p.programId) === String(saved.programId))) {
    return { status: 'current' };
  }

  const league = successorLeague(programs, saved.programName);
  const roster = await fetchJSON(`data/rosters/${encodeURIComponent(saved.programId)}-${encodeURIComponent(saved.teamId)}.json`);
  const players = roster?.players ?? [];
  const peopleRecords = await Promise.all(
    players.map((p) => fetchJSON(`data/people/${encodeURIComponent(p.userId)}.json`)),
  );
  const candidates = rankSuccessorTeams(saved, programs, peopleRecords);

  const teams = (await fetchJSON('data/active-teams-index.json')) ?? [];
  const options = league
    ? teams.filter((t) => String(t.programId) === String(league.programId))
    : [];

  if (isConfidentSuccessor(candidates, players.length)) {
    return { status: 'rolled', suggestion: candidates[0], league, options };
  }
  if (options.length > 0) return { status: 'pick', league, options };
  if (league) return { status: 'waiting', league };
  return { status: 'gone' };
}

// ---------------------------------------------------------------------
// Bottom-bar navigation, shared by every page.
//
// Every page's tab bar marks each tab with data-tab="home|ranks|schedule";
// this is the single place that decides where each one goes, so the three
// tabs mean the same thing everywhere. A page passes whatever context it
// has (its own query params); anything it can't supply falls back to the
// saved team, and a tab with no reachable destination is visibly disabled
// rather than silently doing nothing.
//
//   Home     -> index.html, which is a ROUTER, not a screen: it sends a
//               player whose saved season has ended to season.html, a
//               returning player on to gamenight.html (the next-game
//               feed) or playoffs.html depending on what their program's
//               schedule says is next, and everyone with no saved team
//               straight to search.html. Every Home tab points here and
//               lets the router decide -- no page hardcodes a screen.
//   Court    -> court.html, the venue-wide floor for tonight. Needs no
//               program, so unlike Ranks/Schedule it is never disabled.
//   Ranks    -> rankings.html for the program in context.
//   Schedule -> schedule.html for the program in context.
//
// Matchup and Players are gone as tabs (2026-08-31 redesign): matchup.html
// is retired outright (superseded by tapping any team on Ranks, which now
// shows that team vs. your saved team automatically -- see team.html), and
// player.html is demoted to a secondary link reached by tapping a roster
// row or captain name, not a tab of its own.
function wireTabs({ active, programId, teamId } = {}) {
  const saved = getMyTeam();
  const program = programId ?? saved?.programId ?? null;
  const q = encodeURIComponent;
  const targets = {
    home: 'index.html',
    // No program param, and never disabled: the court map is VENUE-wide.
    // It answers "what is happening in this building tonight", which is a
    // question that does not depend on which team you saved -- or on
    // having saved one at all.
    court: 'court.html',
    ranks: program == null ? null : `rankings.html?program=${q(program)}`,
    schedule: program == null ? null : `schedule.html?program=${q(program)}`,
  };

  for (const el of document.querySelectorAll('.tabbar .tab')) {
    const name = el.dataset.tab;
    const href = targets[name];
    el.classList.toggle('on', name === active);
    el.classList.toggle('off', !href && name !== active);
    el.onclick = href && name !== active ? () => { location.href = href; } : null;
  }
}

document.addEventListener('DOMContentLoaded', injectIcons);

// ---------------------------------------------------------------------
// The match card, shared by gamenight.html and court.html.
//
// Moved out of gamenight.html when court.html needed the same card for
// any match on the floor. Copying it would have meant duplicating ~150
// lines and every future fix to it; app.js is already loaded by every
// page, so it is the one place two pages can share code without a build
// step. The helpers below came with it unchanged.
// ---------------------------------------------------------------------

// The venue's real painted courts, copied verbatim from the broadcast
// board's own paint table (the brackets repo's prototype/board-data.js).
// "The pink court" is what players actually say out loud, which is the
// whole argument for colour-coding -- and the whole reason the match card
// carries the paint and not just a number. `faint` marks the three under
// 3:1 against this ground -- black, maroon, dark green -- which get a
// sand ring rather than reading as a notch cut out of the card. Do not
// edit these by eye: the board's prototype/check-contrast.mjs is what
// asserts the flags, so these values have to stay identical to it.
const COURT = {
  1:  {name:"lime green", hex:"#8CC63F", ink:"#0A0A0A"},
  2:  {name:"orange",     hex:"#F2872F", ink:"#0A0A0A"},
  3:  {name:"blue",       hex:"#2F72C4", ink:"#FFFFFF"},
  4:  {name:"maroon",     hex:"#8E2F3F", ink:"#FFFFFF", faint:true},
  5:  {name:"dark green", hex:"#1F6B3A", ink:"#FFFFFF", faint:true},
  6:  {name:"yellow",     hex:"#F2CE2F", ink:"#0A0A0A"},
  7:  {name:"black",      hex:"#151515", ink:"#FFFFFF", faint:true},
  8:  {name:"pink",       hex:"#E86FA8", ink:"#0A0A0A"},
  9:  {name:"purple",     hex:"#8455C4", ink:"#FFFFFF"},
  10: {name:"white",      hex:"#F4F4F2", ink:"#0A0A0A"},
  11: {name:"red",        hex:"#D93A32", ink:"#FFFFFF"},
  12: {name:"tan",        hex:"#C9A87C", ink:"#0A0A0A"},
};

// setDiffFor/ratingFor copied verbatim from the now-retired matchup.html
// (also duplicated in the now-retired odds.html) -- this project's
// established convention, since there's no build step to share a module
// across pages.
function setDiffFor(teamId, games) {
  return games.reduce((sum, g) => {
    const me = g.teams.find((t) => t.teamId === teamId);
    const opp = g.teams.find((t) => t.teamId !== teamId);
    if (!me || !opp) return sum;
    return sum + (me.score - opp.score);
  }, 0);
}

// Only ever called for a team that has actually played: with gamesPlayed
// 0 both terms divide by zero and every number downstream becomes NaN.
function ratingFor(row, games) {
  const winRate = (row.wins + 0.5 * row.ties) / row.gamesPlayed;
  const setDiffPerGame = setDiffFor(row.teamId, games) / row.gamesPlayed;
  return winRate + setDiffPerGame * 0.05;
}

// Splits 100% between two ratings. A rating can legitimately be negative
// (a winless team with a negative average set differential), and a plain
// ratingA/(ratingA+ratingB) breaks on that: dividing by a negative sum
// INVERTS which team reads as the favorite, and a sum of exactly zero
// yields NaN that Math.max/Math.min can't clamp away. Shifting both
// ratings up by the same constant until neither is negative fixes it
// without touching the gap between them -- the relative ordering and the
// size of the difference, which are what should drive the split, are
// preserved exactly. Kept identical to the now-retired matchup.html's copy.
function splitPct(ratingA, ratingB) {
  const minRating = Math.min(ratingA, ratingB);
  const shift = minRating <= 0 ? -minRating + 0.01 : 0;
  const a = ratingA + shift;
  const b = ratingB + shift;
  let pctA = Math.round((a / (a + b)) * 100);
  pctA = Math.max(1, Math.min(99, pctA));
  return { pctA, pctB: 100 - pctA };
}

// The court number the paint table is keyed by, out of the schedule's
// human court name ("Court 12"). Returns null for anything unnumbered so
// the caller can fall back rather than paint a card off COURT[NaN].
function courtNumberOf(courtName) {
  const m = /(\d+)/.exec(String(courtName ?? ''));
  return m ? Number(m[1]) : null;
}

// "HH:MM" 24-hour, as archive/schedule.js writes it, cut down to what
// fits in the card's corner tag: "6:30p", and "7p" on the hour.
function shortTime(time) {
  const [hh, mm] = String(time).split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return '';
  const suffix = hh >= 12 ? 'p' : 'a';
  const h12 = ((hh + 11) % 12) + 1;
  return mm === 0 ? `${h12}${suffix}` : `${h12}:${String(mm).padStart(2, '0')}${suffix}`;
}

// The corner tag's text. The board's own tag already showed a bare start
// time for an upcoming game; this extends it with the day, because a
// player looking at their phone on Sunday needs to tell Tuesday from
// tonight. "YYYY-MM-DD" is parsed as local calendar fields, not handed to
// `new Date(str)` -- that parses as UTC midnight and can print the wrong
// weekday/day depending on the viewer's timezone.
function whenBadge(dateISO, time) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const game = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((game - today) / 86400000);
  let day;
  if (days === 0) day = 'Today';
  else if (days > 0 && days < 7) day = game.toLocaleDateString(undefined, { weekday: 'short' });
  else day = game.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const t = time ? shortTime(time) : '';
  return t ? `${day} ${t}` : day;
}

// One roster row, close kin to team.html's own markup (first names only,
// captain flagged, each row a drill-down) but laid out as a 2-column grid
// (Eric: "make the roster font larger and split it into 2 columns") rather
// than team.html's single stacked column -- this function is only ever
// called from THIS file's match card, so restructuring its markup can't
// touch team.html's own, separately-generated roster rows at all.
// The name+captain-tag pair is wrapped in its own .rmeta column: at half
// this card's width, "avatar + name + CAPTAIN badge" no longer fits on
// one line the way it did full-width, so the badge now sits on its own
// line under the name instead of clipping or wrapping mid-badge.
function rosterRowsHTML(roster) {
  const players = roster?.players ?? [];
  if (players.length === 0) {
    return '<p style="color:var(--app-faint);font-size:12px;margin:8px 2px">No roster archived for this team yet.</p>';
  }
  return `<div class="rgrid">${players.map((p) => `
    <a class="row-link" href="player.html?person=${encodeURIComponent(p.userId)}">
      <div class="roster-row">
        <div class="ini">${escapeHTML(String(p.firstName).slice(0, 2).toUpperCase())}</div>
        <div class="rmeta">
          <div class="who">${escapeHTML(p.firstName)}</div>
          ${p.isCaptain ? '<div class="cap">Captain</div>' : ''}
        </div>
      </div>
    </a>`).join('')}</div>`;
}

// Head-to-head history between THIS team and THIS opponent specifically --
// not each team's separate overall season form (that was the wrong read of
// the ask; Eric wants "for A vs B matches, one row of history", i.e. only
// games these two exact teams have played against EACH OTHER). Same filter
// the now-retired matchup.html used to find previous meetings (it was
// ~line 115 there: both team ids present on the same game), reused
// verbatim,
// but here it also needs the actual result sequence rather than just
// met.length. Rendered from `teamId`'s (my team's) perspective, same
// result field/letter mapping as team.html's own formDots and the same
// win/loss/tie dot colors -- not the pink/blue "which team" identity
// colors used elsewhere on this card, since there's only one shared row
// now, not one per team. `games` (the full season list) is already
// chronological -- see the archive-order note elsewhere in this file --
// so no re-sort is needed before capping the tail.
function headToHeadHTML(teamId, oppId, games, cap) {
  if (oppId == null) return '<span class="empty">Not yet met this season.</span>';
  const met = games.filter((g) =>
    g.teams.some((t) => t.teamId === teamId) && g.teams.some((t) => t.teamId === oppId));
  if (met.length === 0) return '<span class="empty">Not yet met this season.</span>';
  const dots = met.slice(-cap).map((g) => {
    const me = g.teams.find((t) => t.teamId === teamId);
    const letter = me.result === 'win' ? 'W' : me.result === 'loss' ? 'L' : 'D';
    return `<i class="${letter}"></i>`;
  }).join('');
  return `<span class="fdots">${dots}</span>`;
}

// One match, rendered as the broadcast board's court card: the painted
// slab, both teams with their records, the head-to-head strip, the odds
// split and a roster.
//
// It lives here rather than inside gamenight.html because court.html now
// shows the same card for any match on the floor, and ~150 lines of it is
// far too much to copy. Every page already loads app.js, so this is the
// one place two pages can genuinely share code with no build step -- the
// same reason displayTeamName and wireTabs live here.
//
// focusTeamId is what lets one function serve both callers:
//
//   gamenight.html passes the saved team. That team takes the TOP slot
//   regardless of the data's own order, and the roster shown is the
//   OPPONENT's -- a player looking at their own game wants to see who
//   they are about to face, not their own team-mates.
//
//   court.html passes it only when the saved team happens to be on the
//   court that was tapped, and null otherwise. A neutral matchup keeps
//   the data's order and shows BOTH rosters, because with no "you" in
//   the match there is no "opponent" either.
function matchCardHTML({ game, programId, standings, games, focusTeamId = null, rosters = {} }) {
  const all = game.teams ?? [];
  const focusIdx = focusTeamId == null ? -1
    : all.findIndex((t) => String(t.teamId) === String(focusTeamId));
  const ordered = focusIdx > 0
    ? [all[focusIdx], ...all.filter((_, i) => i !== focusIdx)]
    : all;
  const top = ordered[0] ?? null;
  const bottom = ordered[1] ?? null;

  const rowOf = (t) => (t ? standings?.rows?.find((r) => r.teamId === t.teamId) ?? null : null);
  const topRow = rowOf(top);
  const botRow = rowOf(bottom);
  const nameOf = (t, row) => row?.teamName ?? t?.teamName ?? 'TBD';
  const recOf = (row) => (row ? `${row.wins}-${row.losses}-${row.ties}` : '');

  const courtNum = courtNumberOf(game.courtName);
  const paint = courtNum === null ? null : COURT[courtNum];
  // A court the paint table doesn't know still gets a card: an unpainted
  // slab is a far smaller failure than dropping the game off the page.
  const ct = paint ? paint.hex : 'var(--app-raised)';
  const ctInk = paint ? paint.ink : 'var(--app-ink)';
  const slabText = courtNum === null ? '—' : String(courtNum);
  const paintName = paint ? paint.name : (game.courtName ? String(game.courtName) : 'court TBD');

  const topRating = topRow && topRow.gamesPlayed > 0 ? ratingFor(topRow, games) : null;
  const botRating = botRow && botRow.gamesPlayed > 0 ? ratingFor(botRow, games) : null;

  // A round-robin season rarely puts the same two teams on court more than
  // a small handful of times, so 12 (team.html's own cap) is more headroom
  // than this row will realistically ever need.
  const H2H_CAP = 12;
  const form = `
    <div class="mform">
      <span class="flbl">Previous matches</span>
      ${headToHeadHTML(top?.teamId, bottom?.teamId, games, H2H_CAP)}
    </div>`;

  let odds;
  if (topRating === null || botRating === null) {
    odds = '<div class="h2h-meta">Not enough games played yet for a prediction.</div>';
  } else {
    const { pctA, pctB } = splitPct(topRating, botRating);
    odds = `
      <div class="probbar"><div class="a" style="flex:${pctA}">${pctA}%</div><div class="b" style="flex:${pctB}">${pctB}%</div></div>
      <div class="h2h-meta">Model: season win-rate + set differential per game.</div>`;
  }

  const teamLink = (t, row) => {
    const label = escapeHTML(displayTeamName(nameOf(t, row), { stripCaptain: true }));
    if (!t) return `<span class="tname">${label}</span>`;
    return `<a class="tname" href="team.html?team=${encodeURIComponent(t.teamId)}&program=${encodeURIComponent(programId)}">${label}</a>`;
  };

  // With a focus team there is exactly one "other" roster and it is
  // labelled as such; without one, both are shown under their own names,
  // since neither side is the opponent.
  const rosterBlock = (t, row, label) => `
      <div class="mroster">
        <div class="rlbl">${escapeHTML(label)}</div>
        ${rosterRowsHTML(rosters[t?.teamId] ?? null)}
      </div>`;
  const rosterHTML = focusIdx >= 0
    ? (bottom ? rosterBlock(bottom, botRow, 'Opponent roster') : '')
    : [
      top ? rosterBlock(top, topRow, displayTeamName(nameOf(top, topRow), { stripCaptain: true })) : '',
      bottom ? rosterBlock(bottom, botRow, displayTeamName(nameOf(bottom, botRow), { stripCaptain: true })) : '',
    ].join('');

  return `
    <div class="mgame" style="--ct:${ct};--ct-ink:${ctInk}">
      <div class="mcard${paint?.faint ? ' faint' : ''}">
        <div class="slab" data-paint="${escapeHTML(paintName)}"><span class="cnum">${escapeHTML(slabText)}</span></div>
        <div class="mbody">
          <div class="teams">
            <div class="side a">${teamLink(top, topRow)}${recOf(topRow) ? `<span class="capn">${recOf(topRow)}</span>` : ''}</div>
            <div class="rule"><span class="vs">vs</span></div>
            <div class="side b">${teamLink(bottom, botRow)}${recOf(botRow) ? `<span class="capn">${recOf(botRow)}</span>` : ''}</div>
          </div>
        </div>
        <span class="statetag">${escapeHTML(whenBadge(game.date, game.time))}</span>
      </div>
      ${form}
      <div class="modds">${odds}</div>
      ${rosterHTML}
    </div>`;
}
