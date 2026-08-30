// docs/tests/run.js — dev-time only. Serves docs/ (the directory GitHub
// Pages publishes) with tests/fixtures/data substituted for the real
// docs/data/ folder, so the pages need zero test-awareness -- their plain
// relative fetch('data/...') calls resolve to the fixtures instead.
// Run with: node docs/tests/run.js

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(__dirname, '..'); // docs/
const FIXTURE_DATA = join(__dirname, 'fixtures', 'data');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const root = filePath.startsWith('/data/') ? FIXTURE_DATA : DOCS_ROOT;
  const rel = filePath.startsWith('/data/') ? filePath.slice('/data'.length) : filePath;
  const full = join(root, rel);
  try {
    await stat(full);
    const ext = full.slice(full.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(await readFile(full));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolve) => server.listen(8123, resolve));
console.log('test server on :8123');

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();
let pageErrors = 0;
page.on('pageerror', (err) => {
  pageErrors++;
  console.error('PAGE ERROR:', err.message);
});

let failures = 0;
function check(label, cond) {
  console.log(cond ? `PASS ${label}` : `FAIL ${label}`);
  if (!cond) failures++;
}

const BASE = 'http://localhost:8123';
const go = (path) => page.goto(`${BASE}/${path}`, { waitUntil: 'networkidle0' });
const path = () => new URL(page.url()).pathname + new URL(page.url()).search;
const clickThrough = (selector) =>
  Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click(selector)]);

// Every check below starts from a clean device: no saved team.
await go('index.html');
await page.evaluate(() => localStorage.clear());

// ---- page content -------------------------------------------------------
await go('index.html');
await page.type('#q', 'test', { delay: 20 });
await new Promise((r) => setTimeout(r, 300));
check('index search finds Testers United for query "test"', (await page.content()).includes('Testers United'));
check(
  'index search excludes teams that do not match the query',
  !(await page.content()).includes('Fixture FC'),
);
// The entry point must be able to scroll its results: 15 matches at ~72px
// each overflow any phone screen, and this page used to have no scroller.
check(
  'index results live in the scrollable .body pane',
  await page.$eval('#results', (el) => el.classList.contains('body') && getComputedStyle(el).overflowY === 'auto'),
);

await go('rankings.html?program=9001');
check('rankings shows Testers United', (await page.content()).includes('Testers United'));

await go('team.html?program=9001&team=501');
check('team page shows record 8-1-1', (await page.content()).includes('8-1-1'));
check('team page lists its roster by first name', (await page.content()).includes('Sam'));

await go('matchup.html?program=9001&team=501');
await page.select('#oppPicker', '502');
await new Promise((r) => setTimeout(r, 200));
check('matchup shows a probability bar', (await page.content()).includes('probbar'));

// A team that has not played yet has no rating to divide by: the page must
// say so rather than rendering "NaN%".
await go('matchup.html?program=9001&team=503');
await page.select('#oppPicker', '501');
await new Promise((r) => setTimeout(r, 200));
{
  // Rendered text, not page HTML: the page's own source comments mention NaN.
  const rendered = await page.$eval('#result', (el) => el.innerText);
  check('matchup never renders NaN for a 0-game team', !rendered.includes('NaN'));
  check('matchup explains why there is no prediction for a 0-game team', rendered.includes('played a game yet'));
}

await go('player.html?person=1');
{
  const content = await page.content();
  check(
    'player card shows the first name but never renders fields outside its schema (e.g. an internal-only note)',
    content.includes('Sam') && !content.includes('internal-only'),
  );
}

await go('odds.html?program=9001');
{
  const content = await page.content();
  // Hand-computed from fixtures/data/standings/9001.json + activities/9001.json:
  // team 501 (8-1-1, +2 set diff over 1 game) rates 0.86; team 502 (6-3-1, -2 set diff) rates 0.64.
  // Both are within the top-CUTOFF(4) here, so both floor at >=50%; no team holds position 4, so
  // the cutoff rating falls back to the lowest-rated team's own rating (0.64), giving team 501 a
  // gap of +0.22 -> 50+88=138, clamped to 100%, and team 502 a gap of 0 -> exactly 50%. Team 503
  // has played nothing and gets no percentage at all.
  check('odds page shows the correct playoff percentage for the leader (100%)', content.includes('100%'));
  check('odds page shows the correct playoff percentage for the trailing team (50%)', content.includes('50%'));
  const renderedOdds = await page.$eval('#rows', (el) => el.innerText);
  check('odds page shows no percentage for a 0-game team', !renderedOdds.includes('NaN') && renderedOdds.includes('—'));
}

// ---- navigation: every page reachable using only in-app links -----------
// Nothing below types a URL; each step clicks what a real player would.
await go('index.html');
await page.evaluate(() => localStorage.clear());
await go('index.html');
await page.type('#q', 'testers', { delay: 20 });
await new Promise((r) => setTimeout(r, 300));
await clickThrough('.result');
check('search result -> team page', path().startsWith('/team.html') && path().includes('team=501'));

await clickThrough('.tab[data-tab="ranks"]');
check('team page Ranks tab -> rankings', path() === '/rankings.html?program=9001');

await clickThrough('#oddsLink');
check('rankings -> playoff odds', path() === '/odds.html?program=9001');

await clickThrough('.tab[data-tab="matchup"]');
check(
  'odds Matchup tab -> matchup, carrying BOTH program and team',
  path().includes('program=9001') && path().includes('team=501'),
);

await clickThrough('.tab[data-tab="ranks"]');
await clickThrough('.row-link');
check('rankings row -> team page (the drill-down the spec describes)', path().startsWith('/team.html'));

await clickThrough('.card .row-link');
check('team roster row -> player card', path() === '/player.html?person=1');

await clickThrough('.tab[data-tab="home"]');
check('player card Home tab -> back to the saved team', path().startsWith('/team.html'));

// The Players tab resolves the team's captain from the roster file.
await go('rankings.html?program=9001');
await new Promise((r) => setTimeout(r, 300));
check(
  'Players tab is enabled once the saved team roster resolves',
  await page.$eval('.tab[data-tab="players"]', (el) => !el.classList.contains('off')),
);
await clickThrough('.tab[data-tab="players"]');
check('rankings Players tab -> the team captain card', path() === '/player.html?person=1');

// ---- a stale saved team must recover, not bounce forever ----------------
await go('index.html');
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9999, teamId: 8888, teamName: 'Gone Team', programName: 'Dead League' }),
));
await go('index.html');
check('a stale saved team lands on the cannot-find-this-team message', (await page.content()).includes('find this team'));
check('the stale pointer is cleared', (await page.evaluate(() => localStorage.getItem('thirdcoast-my-team'))) === null);
await clickThrough('a[href="index.html"]');
check('search again now reaches the search box instead of redirecting back', (await page.$('#q')) !== null);

check(`no uncaught page errors (${pageErrors} occurred)`, pageErrors === 0);

await browser.close();
server.close();

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all UI checks passed');
}
