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

// Temporary diagnostic for the "floating tab bar" report -- three
// established CSS fixes (padding, 100dvh, position:fixed) all landed
// with zero visible change, which means the assumption behind all
// three (a viewport-height calculation problem) is probably wrong.
// Rather than guess a fourth CSS fix blind, this renders the actual
// numbers on-device, so a screenshot of THIS tells us what is really
// happening instead of what CSS theory says should be happening.
// Remove once the bug is actually found -- not meant to ship long-term.
//
// Reachable two ways, and the second is the one that matters: the bug is
// only reported in the INSTALLED app, which has no address bar, so
// ?debug=1 cannot be typed in the one mode where the bug occurs. That is
// very likely why this diagnostic has not yet produced an answer. Five
// taps on the topbar opens it from inside the installed app.
const DEBUG_TAPS_NEEDED = 5;
const DEBUG_TAP_WINDOW_MS = 3000;

function debugReadout() {
  const screenEl = document.querySelector('.screen');
  const tabbarEl = document.querySelector('.tabbar');
  const sr = screenEl?.getBoundingClientRect();
  const tr = tabbarEl?.getBoundingClientRect();
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom);padding-top:env(safe-area-inset-top);';
  document.body.appendChild(probe);
  const probeStyle = getComputedStyle(probe);
  const safeBottom = probeStyle.paddingBottom;
  const safeTop = probeStyle.paddingTop;
  probe.remove();
  const round = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : n);
  // The single number the whole investigation turns on: how much of the
  // viewport sits BELOW the tab bar. Computed here rather than left as
  // mental arithmetic off two other rows, because this is what a
  // screenshot has to answer in one glance.
  const gap = tr ? round(window.innerHeight - tr.bottom) : 'n/a';
  return [
    `GAP below .tabbar: ${gap}px   <-- the bug, in one number`,
    '',
    `navigator.standalone: ${window.navigator.standalone}`,
    // The reliable standalone test: navigator.standalone is a non-standard
    // Safari-ism and reads undefined for a manifest-driven install, which
    // is how iOS 16.4+ installs this app.
    `display-mode standalone: ${window.matchMedia('(display-mode: standalone)').matches}`,
    `innerHeight: ${window.innerHeight}`,
    `docEl.clientHeight: ${document.documentElement.clientHeight}`,
    `visualViewport.height: ${round(window.visualViewport?.height)}`,
    `visualViewport.offsetTop: ${round(window.visualViewport?.offsetTop)}`,
    `screen.height: ${window.screen?.height}  avail: ${window.screen?.availHeight}`,
    `devicePixelRatio: ${window.devicePixelRatio}`,
    `.screen rect: top=${round(sr?.top)} bottom=${round(sr?.bottom)} h=${round(sr?.height)}`,
    `.screen position: ${screenEl ? getComputedStyle(screenEl).position : 'n/a'}`,
    `.tabbar rect: top=${round(tr?.top)} bottom=${round(tr?.bottom)} h=${round(tr?.height)}`,
    `.tabbar pad-bottom: ${tabbarEl ? getComputedStyle(tabbarEl).paddingBottom : 'n/a'}`,
    `env(safe-area-inset-top): ${safeTop}`,
    `env(safe-area-inset-bottom): ${safeBottom}`,
    // Identifies what the dark strip actually IS. .tabbar is the lighter
    // --app-surface and body/.screen are the darker --app-bg, so whichever
    // colour the gap renders as names the element that is coming up short.
    `body bg: ${getComputedStyle(document.body).backgroundColor}`,
    `.screen bg: ${screenEl ? getComputedStyle(screenEl).backgroundColor : 'n/a'}`,
    `.tabbar bg: ${tabbarEl ? getComputedStyle(tabbarEl).backgroundColor : 'n/a'}`,
  ].join('\n');
}

function showDebugOverlay() {
  if (document.getElementById('dbg-overlay')) return;
  const box = document.createElement('div');
  box.id = 'dbg-overlay';
  box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#000;color:#0f0;' +
    'font:11px/1.5 monospace;padding:10px;white-space:pre-wrap;';
  box.textContent = debugReadout() + '\n\n(tap to dismiss)';
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

function wireDebugOverlay() {
  if (new URLSearchParams(location.search).get('debug') === '1') showDebugOverlay();
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  let taps = 0;
  let first = 0;
  topbar.addEventListener('click', () => {
    const now = Date.now();
    if (now - first > DEBUG_TAP_WINDOW_MS) { taps = 0; first = now; }
    taps += 1;
    if (taps >= DEBUG_TAPS_NEEDED) { taps = 0; showDebugOverlay(); }
  });
}
document.addEventListener('DOMContentLoaded', wireDebugOverlay);
