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
