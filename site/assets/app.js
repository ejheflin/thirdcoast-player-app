// site/assets/app.js — shared across every page. No framework, no build
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

document.addEventListener('DOMContentLoaded', injectIcons);
