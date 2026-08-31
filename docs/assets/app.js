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

// ---------------------------------------------------------------------
// Bottom-bar navigation, shared by every page.
//
// Every page's tab bar marks each tab with data-tab="home|ranks|matchup|
// players"; this is the single place that decides where each one goes, so
// the four tabs mean the same thing everywhere. A page passes whatever
// context it has (its own query params); anything it can't supply falls
// back to the saved team, and a tab with no reachable destination is
// visibly disabled rather than silently doing nothing.
//
//   Home     -> index.html, which is a ROUTER, not a screen: it sends a
//               returning player on to gamenight.html (the next-game
//               feed) or playoffs.html depending on what their program's
//               schedule says is next, and everyone with no saved team
//               straight to search.html. Every Home tab points here and
//               lets the router decide -- no page hardcodes a screen.
//   Ranks    -> rankings.html for the program in context.
//   Matchup  -> matchup.html for the team in context.
//   Players  -> the player card for the team in context's captain (there
//               is no browse-all-players page; the team's own roster is
//               the honest "players" destination this data supports).
async function captainCardHref(programId, teamId) {
  if (programId == null || teamId == null || programId === '' || teamId === '') return null;
  const roster = await fetchJSON(
    `data/rosters/${encodeURIComponent(programId)}-${encodeURIComponent(teamId)}.json`,
  ).catch(() => null);
  const players = roster?.players ?? [];
  const target = players.find((p) => p.isCaptain) ?? players[0];
  return target ? `player.html?person=${encodeURIComponent(target.userId)}` : null;
}

function wireTabs({ active, programId, teamId, personId } = {}) {
  const saved = getMyTeam();
  const program = programId ?? saved?.programId ?? null;
  const team = teamId ?? saved?.teamId ?? null;
  const q = encodeURIComponent;
  const targets = {
    home: 'index.html',
    ranks: program == null ? null : `rankings.html?program=${q(program)}`,
    matchup: program == null || team == null ? null : `matchup.html?program=${q(program)}&team=${q(team)}`,
    players: personId == null ? null : `player.html?person=${q(personId)}`,
  };

  const apply = () => {
    for (const el of document.querySelectorAll('.tabbar .tab')) {
      const name = el.dataset.tab;
      const href = targets[name];
      el.classList.toggle('on', name === active);
      el.classList.toggle('off', !href && name !== active);
      // onclick (not addEventListener) so re-running this once a roster
      // resolves replaces the handler instead of stacking another one.
      el.onclick = href && name !== active ? () => { location.href = href; } : null;
    }
  };
  apply();

  if (targets.players === null && active !== 'players') {
    captainCardHref(program, team).then((href) => {
      if (!href) return;
      targets.players = href;
      apply();
    });
  }
}

document.addEventListener('DOMContentLoaded', injectIcons);
