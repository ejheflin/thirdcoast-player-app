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
// Freshness after the phone has been locked.
//
// An installed PWA is not reloaded when it comes back to the foreground:
// iOS just thaws the page exactly as it was. Open the app at 7:30, lock
// the phone, unlock at 9:30, and every screen still shows 7:30's world --
// the court map's live slot, the "next game" card for a game that is
// already over, and data the archiver has since refreshed. So a page that
// has been out of sight for a long stretch, or across midnight, reloads
// itself the moment it is visible again. A short glance away (under half
// an hour) keeps the page as it was, so a tapped court or an open search
// is not thrown away for nothing.
const STALE_AFTER_MS = 30 * 60 * 1000;
const localDay = () => new Date().toDateString();
const _loadedDay = localDay();
let _hiddenAt = null;

function reloadIfStale() {
  const away = _hiddenAt === null ? 0 : Date.now() - _hiddenAt;
  if (away > STALE_AFTER_MS || localDay() !== _loadedDay) location.reload();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) _hiddenAt = Date.now();
  else reloadIfStale();
});
// A page restored from the back/forward cache fires pageshow, not a
// fresh load -- same staleness, same check.
window.addEventListener('pageshow', (e) => { if (e.persisted) reloadIfStale(); });

// ---------------------------------------------------------------------
// Team history badges.
//
// data/lineage/{programId}.json (written by archive/lineage.js) links each
// team to the team it was last season, found by who is on the roster
// rather than by name. `move` is 'up' / 'down' when that season was a
// different level of the same format -- the "did they come up into my
// league, or down into it" question.

const _lineage = new Map();
function fetchLineage(programId) {
  const key = String(programId);
  if (!_lineage.has(key)) {
    _lineage.set(key, fetchJSON(`data/lineage/${encodeURIComponent(key)}.json`).catch(() => null));
  }
  return _lineage.get(key);
}

const DAY_ABBR = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const dayOf = (programName) => String(programName ?? '').split(/\s+/)[0];

// "Up from B", or "Up from Mon B" when last season was on another night --
// a bare "B" would read as this night's B league.
function moveBadgeHTML(entry, programName) {
  if (!entry?.from || (entry.move !== 'up' && entry.move !== 'down')) return '';
  const fromDay = dayOf(entry.from.programName);
  const otherNight = fromDay !== dayOf(programName) && DAY_ABBR[fromDay];
  const where = `${otherNight ? `${DAY_ABBR[fromDay]} ` : ''}${entry.from.level ?? ''}`.trim();
  const up = entry.move === 'up';
  const title = `${up ? 'Promoted' : 'Moved down'} from ${entry.from.programName}`;
  return `<span class="mv ${entry.move}" title="${escapeHTML(title)}">${up ? '▲' : '▼'} ${up ? 'Up' : 'Down'} from ${escapeHTML(where)}</span>`;
}

// When a season happened, told by when it ended: "Nov 2026".
function seasonLabel(endDate) {
  if (!endDate) return '';
  return new Date(endDate).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

// ---------------------------------------------------------------------
// Omnisearch: the magnifier in the top-right of every page's top bar.
//
// One index (data/search-index.json, see archive/fetch.js'
// buildSearchIndex) holds every team and every player across every season
// the archive knows. It is only fetched the first time someone opens the
// search, and then kept for the life of the page.

let _searchIndex = null;
function loadSearchIndex() {
  if (!_searchIndex) {
    _searchIndex = fetchJSON('data/search-index.json').then((raw) => {
      if (!raw) return null;
      const programs = raw.programs.map(([id, name, endDate, state]) => ({
        id, name, endDate, active: state === 'LIVE' || state === 'UPCOMING',
      }));
      return {
        programs,
        teams: raw.teams.map(([p, teamId, teamName, seasons]) => ({ program: programs[p], teamId, teamName, seasons })),
        people: raw.people.map(([userId, firstName, p, teamId, teamName, seasons]) => ({
          userId, firstName, program: programs[p], teamId, teamName, seasons,
        })),
      };
    }).catch(() => null);
  }
  return _searchIndex;
}

// 0 = the name starts with the query, 1 = a word in it does, 2 = it is in
// there somewhere, null = no match. Every extra word typed must appear in
// the result's team or league text too, so "sam tuesday" narrows the Sams.
function omniScore(primary, extra, tokens) {
  const name = primary.toLowerCase();
  const [first, ...rest] = tokens;
  const hay = `${name} ${extra.toLowerCase()}`;
  if (!rest.every((t) => hay.includes(t))) return null;
  if (name.startsWith(first)) return 0;
  if (new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) return 1;
  if (name.includes(first)) return 2;
  return null;
}

function omniMatch(index, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const people = [];
  for (const p of index.people) {
    const score = omniScore(p.firstName, `${p.teamName} ${p.program.name}`, tokens);
    if (score !== null) people.push({ ...p, score });
  }
  // Newest first within a score: the person still playing is the one
  // most likely being looked for. index.programs is newest-first, so a
  // lower program position means more recent.
  const pos = new Map(index.programs.map((p, i) => [p, i]));
  people.sort((a, b) => a.score - b.score || pos.get(a.program) - pos.get(b.program) || b.seasons - a.seasons);

  // One row per team NAME, pointing at its newest season: the same name
  // five seasons running is one team to a person searching, not five.
  const byName = new Map();
  for (const t of index.teams) {
    const label = displayTeamName(t.teamName, { stripCaptain: true });
    const key = label.toLowerCase();
    const score = omniScore(label, `${t.teamName} ${t.program.name}`, tokens);
    if (score === null) continue;
    const seen = byName.get(key);
    // index.teams is already newest-first, so the first hit is the newest.
    if (!seen) byName.set(key, { ...t, label, score, count: 1 });
    else seen.count += 1;
  }
  const teams = [...byName.values()].sort((a, b) =>
    a.score - b.score || pos.get(a.program) - pos.get(b.program));

  return { people, teams };
}

const OMNI_LIMIT = 8;

function omniResultsHTML(result) {
  if (!result) return '<p class="omni-hint">Search any player or team, from any season.</p>';
  const { people, teams } = result;
  if (people.length === 0 && teams.length === 0) return '<p class="omni-hint">No players or teams match that.</p>';
  const now = (program) => (program.active ? '<i class="omni-now">Now</i>' : '');
  const more = (n, what) => (n > OMNI_LIMIT
    ? `<p class="omni-more">Showing ${OMNI_LIMIT} of ${n} ${what} — add a team or league name to narrow it.</p>` : '');
  const seasons = (n) => `${n} season${n === 1 ? '' : 's'}`;

  const peopleHTML = people.slice(0, OMNI_LIMIT).map((p) => `
    <a class="omni-row" href="player.html?person=${encodeURIComponent(p.userId)}">
      <span class="ini">${escapeHTML(String(p.firstName).slice(0, 2).toUpperCase())}</span>
      <span class="omni-meta">
        <b>${escapeHTML(p.firstName)} ${now(p.program)}</b>
        <span>${escapeHTML(displayTeamName(p.teamName, { stripCaptain: true }))} · ${escapeHTML(p.program.name)} · ${seasons(p.seasons)}</span>
      </span>
    </a>`).join('');
  const teamsHTML = teams.slice(0, OMNI_LIMIT).map((t) => `
    <a class="omni-row" href="team.html?team=${encodeURIComponent(t.teamId)}&program=${encodeURIComponent(t.program.id)}">
      <span class="ini team">${escapeHTML(t.label.slice(0, 2).toUpperCase())}</span>
      <span class="omni-meta">
        <b>${escapeHTML(t.label)} ${now(t.program)}</b>
        <span>${escapeHTML(t.program.name)} · ${escapeHTML(seasonLabel(t.program.endDate))} · ${seasons(t.seasons)}</span>
      </span>
    </a>`).join('');

  return `
    ${people.length ? `<div class="sec-lbl">Players</div><div class="card omni-list">${peopleHTML}</div>${more(people.length, 'players')}` : ''}
    ${teams.length ? `<div class="sec-lbl">Teams</div><div class="card omni-list">${teamsHTML}</div>${more(teams.length, 'teams')}` : ''}`;
}

function openOmnisearch() {
  const screen = document.querySelector('.screen');
  if (!screen || screen.querySelector('.omni')) return;
  const sheet = document.createElement('div');
  sheet.className = 'omni';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Search players and teams');
  sheet.innerHTML = `
    <div class="omni-head">
      <label class="omni-field">
        <svg class="icon"><use href="#i-search"/></svg>
        <input type="search" placeholder="Player or team name…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
      </label>
      <button type="button" class="omni-cancel">Cancel</button>
    </div>
    <div class="omni-body"><p class="omni-hint">Search any player or team, from any season.</p></div>`;
  screen.appendChild(sheet);

  const input = sheet.querySelector('input');
  const body = sheet.querySelector('.omni-body');
  const close = () => { sheet.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  sheet.querySelector('.omni-cancel').addEventListener('click', close);

  let index = null;
  const render = () => {
    const q = input.value.trim();
    if (!q) { body.innerHTML = omniResultsHTML(null); return; }
    if (!index) { body.innerHTML = '<p class="omni-hint">Loading…</p>'; return; }
    body.innerHTML = omniResultsHTML(omniMatch(index, q));
  };
  input.addEventListener('input', render);
  loadSearchIndex().then((idx) => {
    index = idx;
    if (!idx) { body.innerHTML = '<p class="omni-hint">Search isn\'t available yet — check back after the next data refresh.</p>'; return; }
    render();
  });
  input.focus();
}

// Every page with a top bar gets the magnifier, top right. search.html has
// no .topbar -- it IS a search, of the active leagues only, for saving a
// team -- so it is left alone.
function mountOmnisearch() {
  const bar = document.querySelector('.topbar');
  if (!bar || bar.querySelector('.omni-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'omni-btn';
  btn.setAttribute('aria-label', 'Search players and teams');
  btn.innerHTML = '<svg class="icon"><use href="#i-search"/></svg>';
  btn.addEventListener('click', openOmnisearch);
  bar.appendChild(btn);
}
document.addEventListener('DOMContentLoaded', mountOmnisearch);

// ---------------------------------------------------------------------
// "Put this on your Home Screen" -- a full-screen guide for anyone using
// the site in a plain phone browser instead of the installed app.
//
// The installed app is the real product: full screen, no browser chrome,
// opens straight to the next game. But most people have never installed
// a web app and do not know it is possible, so every VISIT from a phone
// browser opens with the guide. Dismissing it quiets it for the rest of
// that visit (sliding 30 minutes, the same "you have been away" line
// app.js' freshness check uses) -- not forever.
//
// What each platform actually allows:
//   android     Chrome hands us a real install prompt (beforeinstallprompt),
//               so the guide is one big Install button. Without it (another
//               browser, or Chrome not offering yet) it falls back to steps.
//   ios-safari  No web page can open Safari's "Add to Home Screen" --
//               navigator.share() opens a share sheet WITHOUT that row -- so
//               the guide animates the steps and points an arrow at the
//               real Share button in Safari's own toolbar.
//   ios-other   Chrome/Firefox/Edge on iOS: Share lives in the address bar.
//   inapp       Instagram/Facebook/Gmail-style in-app browsers cannot
//               install anything; the only way forward is to open the page
//               in a real browser first, so that is all it asks.
// Desktop gets nothing: there is no Home Screen to put it on.

const NAG_KEY = 'thirdcoast-install-nag-dismissed';
const NAG_QUIET_MS = 30 * 60 * 1000;

let _installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  // Hold Chrome's prompt for our own button rather than its mini-infobar.
  e.preventDefault();
  _installPrompt = e;
  document.querySelector('.install-nag')?.classList.add('can-install');
});
window.addEventListener('appinstalled', () => document.querySelector('.install-nag')?.remove());

function isInstalledApp() {
  if (navigator.standalone === true) return true; // iOS home-screen app
  return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => matchMedia(`(display-mode: ${m})`).matches);
}

function installPlatform() {
  // Test hook: the UI suite forces a platform; everything else about a
  // headless browser (navigator.webdriver) keeps the guide out of the way.
  if (window.__installNag !== undefined) return window.__installNag;
  if (navigator.webdriver || isInstalledApp()) return null;
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; a Mac with a touchscreen is an iPad.
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  if (!iOS && !android) return null;
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|LinkedInApp|GSA\/|Twitter|MicroMessenger/.test(ua)) return 'inapp';
  if (iOS) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  return 'android';
}

function nagQuiet() {
  try {
    const at = Number(localStorage.getItem(NAG_KEY));
    return at > 0 && Date.now() - at < NAG_QUIET_MS;
  } catch { return false; }
}
function markNagQuiet() {
  try { localStorage.setItem(NAG_KEY, String(Date.now())); } catch { /* private mode: just close */ }
}

// Safari's own glyphs, drawn so the guide shows exactly what to look for.
const SHARE_GLYPH = '<svg class="ig" viewBox="0 0 24 24"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ADD_GLYPH = '<svg class="ig" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8.5v7M8.5 12h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const MORE_GLYPH = '<svg class="ig" viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.9" fill="currentColor"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><circle cx="18.5" cy="12" r="1.9" fill="currentColor"/></svg>';
const KEBAB_GLYPH = '<svg class="ig" viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="1.9" fill="currentColor"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><circle cx="12" cy="18.5" r="1.9" fill="currentColor"/></svg>';

// The looping walkthrough: a little phone doing every tap, one frame per
// tap, with a caption naming it. Drawn rather than a GIF -- crisp at any
// pixel density, a fraction of the bytes, in this app's own colours --
// and stepped by startInstallDemo(), because Safari 26 has one more tap
// than older Safari (••• before Share) and fixed CSS timings cannot vary
// the frame count.
function installDemoHTML({ behindMore = false } = {}) {
  const frame = (cap, body) => `<div class="nd-frame" data-cap="${escapeHTML(cap)}">${body}</div>`;
  const tap = (cls) => `<div class="nd-tap ${cls}"></div>`;
  const frames = [];
  if (behindMore) {
    // Safari 26's compact toolbar: back, the address pill, then •••.
    frames.push(frame('Tap •••',
      `<div class="nd-bar compact"><span>‹</span><span class="nd-url">3cvb</span><b class="nd-more">${MORE_GLYPH}</b></div>${tap('at-more')}`));
    frames.push(frame('Tap Share',
      `<div class="nd-bar compact"><span>‹</span><span class="nd-url">3cvb</span><b class="nd-more">${MORE_GLYPH}</b></div>
       <div class="nd-menu"><div class="nd-row hl">Share ${SHARE_GLYPH}</div><div class="nd-row">Add to Bookmarks</div><div class="nd-row">Add to Favorites</div><div class="nd-row">New Tab</div></div>${tap('at-menu-share')}`));
  } else {
    frames.push(frame('Tap Share',
      `<div class="nd-bar"><span>‹</span><span>›</span><b class="nd-share">${SHARE_GLYPH}</b><span>▢</span><span>⋯</span></div>${tap('at-share')}`));
  }
  frames.push(frame('Tap Add to Home Screen',
    `<div class="nd-sheet"><div class="nd-row">Copy</div><div class="nd-row">Add to Reading List</div><div class="nd-row hl">Add to Home Screen ${ADD_GLYPH}</div><div class="nd-row">Add Bookmark</div></div>${tap('at-sheet')}`));
  frames.push(frame('Tap Add',
    `<div class="nd-dialog"><div class="nd-dh"><span>Cancel</span><b>Add</b></div><div class="nd-app"><img src="assets/icon-180.png" alt=""><span>3CVB</span></div></div>${tap('at-add')}`));
  frames.push(frame('Open 3CVB from your Home Screen',
    '<div class="nd-home"><i></i><i></i><i></i><img src="assets/icon-180.png" alt=""><i></i><i></i><i></i><i></i></div>'));
  return `
    <div class="nag-demo" aria-hidden="true">
      <div class="nd-screen">
        <div class="nd-page"><i></i><i></i><i></i><i></i></div>
        ${frames.join('')}
      </div>
    </div>
    <p class="nd-cap" aria-hidden="true"></p>`;
}

// Steps the demo one frame per tap, looping, until the guide is closed.
const DEMO_FRAME_MS = 2200;
function startInstallDemo(nag) {
  const frames = [...nag.querySelectorAll('.nd-frame')];
  const cap = nag.querySelector('.nd-cap');
  if (frames.length === 0) return;
  const slow = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0;
  const show = () => {
    frames.forEach((f, n) => f.classList.toggle('on', n === i));
    if (cap) cap.textContent = `${i + 1}. ${frames[i].dataset.cap}`;
  };
  show();
  const timer = setInterval(() => {
    if (!nag.isConnected) { clearInterval(timer); return; }
    i = (i + 1) % frames.length;
    show();
  }, slow ? DEMO_FRAME_MS * 2 : DEMO_FRAME_MS);
}

function installNagHTML(platform) {
  const ua = navigator.userAgent;
  const iPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Safari 26 tucked Share behind the ••• button in its compact toolbar.
  const safariMajor = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
  const behindMore = platform === 'ios-safari' && !iPad && safariMajor >= 26;

  let steps; let arrow = ''; let demo = '';
  if (platform === 'ios-safari') {
    demo = installDemoHTML({ behindMore });
    steps = [
      behindMore
        ? `Tap ${MORE_GLYPH} in the bottom-right corner, then <b>Share</b> ${SHARE_GLYPH}`
        : `Tap <b>Share</b> ${SHARE_GLYPH} ${iPad ? 'at the top of the screen' : 'in the toolbar at the bottom'}`,
      `Scroll down and tap <b>Add to Home Screen</b> ${ADD_GLYPH} <small>(under “View More” if you don't see it)</small>`,
      'Tap <b>Add</b> — then open 3CVB from your Home Screen',
    ];
    arrow = iPad ? 'top-right' : behindMore ? 'bottom-right' : 'bottom-center';
  } else if (platform === 'ios-other') {
    demo = installDemoHTML({ behindMore });
    steps = [
      `Tap <b>Share</b> ${SHARE_GLYPH} in the address bar`,
      `Tap <b>Add to Home Screen</b> ${ADD_GLYPH} <small>(under “More” if you don't see it)</small>`,
      'Tap <b>Add</b> — then open 3CVB from your Home Screen',
    ];
    arrow = 'top-right';
  } else if (platform === 'android') {
    steps = [
      `Tap ${KEBAB_GLYPH} at the top right of your browser`,
      'Tap <b>Install app</b> or <b>Add to Home screen</b>',
      'Tap <b>Install</b> — then open 3CVB from your Home Screen',
    ];
    arrow = 'top-right';
  } else {
    steps = [
      `Tap ${MORE_GLYPH} or ${KEBAB_GLYPH} in this app's corner`,
      'Choose <b>Open in browser</b> (or Safari / Chrome)',
      'Then add it to your Home Screen from there',
    ];
  }

  return `
    <div class="nag-scroll">
      <img class="nag-icon" src="assets/icon-180.png" alt="">
      <h2>${platform === 'inapp' ? 'Open this in your browser' : 'Get the 3CVB app'}</h2>
      <p class="nag-lede">${platform === 'inapp'
        ? 'This app can\'t be installed from inside another app. Open it in Safari or Chrome to add it to your Home Screen.'
        : 'Add it to your Home Screen: full screen, no browser bars, one tap from your next game. It\'s free and takes 10 seconds.'}</p>
      ${platform === 'android' ? '<button type="button" class="nag-install">Install app</button><p class="nag-or">or do it by hand:</p>' : ''}
      ${platform === 'inapp' ? '<button type="button" class="nag-copy">Copy link</button>' : ''}
      ${demo}
      <ol class="nag-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      ${platform === 'inapp' ? '' : '<p class="nag-note">After installing, pick your team once more in the app — it keeps its own settings, separate from this browser.</p>'}
      <button type="button" class="nag-later">Not now, continue in the browser</button>
    </div>
    ${arrow ? `<div class="nag-arrow ${arrow}" aria-hidden="true">${arrow.startsWith('top') ? '↑' : '↓'}</div>` : ''}`;
}

function mountInstallNag() {
  // index.html is a router that navigates away immediately; the guide
  // opens on the page it lands on instead of flashing on the way through.
  if (/(^|\/)(index\.html)?$/.test(location.pathname)) return;
  const platform = installPlatform();
  if (!platform) return;
  if (nagQuiet()) { markNagQuiet(); return; } // still this visit: slide the window
  const screen = document.querySelector('.screen');
  if (!screen || screen.querySelector('.install-nag')) return;

  const nag = document.createElement('div');
  nag.className = `install-nag${_installPrompt ? ' can-install' : ''}`;
  nag.dataset.platform = platform;
  nag.setAttribute('role', 'dialog');
  nag.setAttribute('aria-modal', 'true');
  nag.setAttribute('aria-label', 'Add 3CVB to your Home Screen');
  nag.innerHTML = installNagHTML(platform);
  screen.appendChild(nag);
  startInstallDemo(nag);

  const close = () => { markNagQuiet(); nag.remove(); };
  nag.querySelector('.nag-later').addEventListener('click', close);
  nag.querySelector('.nag-install')?.addEventListener('click', async () => {
    if (!_installPrompt) return;
    _installPrompt.prompt();
    const { outcome } = await _installPrompt.userChoice;
    _installPrompt = null;
    nag.classList.remove('can-install');
    if (outcome === 'accepted') nag.remove();
  });
  nag.querySelector('.nag-copy')?.addEventListener('click', async (e) => {
    const url = new URL('.', location.href).href;
    try { await navigator.clipboard.writeText(url); e.target.textContent = 'Copied — paste it into Safari or Chrome'; }
    catch { e.target.textContent = url; }
  });
}
document.addEventListener('DOMContentLoaded', mountInstallNag);

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
