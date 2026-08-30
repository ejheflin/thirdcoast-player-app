// site/tests/run.js — dev-time only. Serves site/ with tests/fixtures/data
// substituted for the real data/ folder, then drives it with Puppeteer.
// Run with: node site/tests/run.js

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = join(__dirname, '..');
const FIXTURE_DATA = join(__dirname, 'fixtures', 'data');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const root = filePath.startsWith('/data/') ? FIXTURE_DATA : SITE_ROOT;
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

await page.goto('http://localhost:8123/index.html', { waitUntil: 'networkidle0' });
await page.type('#q', 'test', { delay: 20 });
await new Promise((r) => setTimeout(r, 300));
check('index search finds Testers United for query "test"', (await page.content()).includes('Testers United'));

await page.goto('http://localhost:8123/rankings.html?program=9001', { waitUntil: 'networkidle0' });
check('rankings shows Testers United', (await page.content()).includes('Testers United'));

await page.goto('http://localhost:8123/team.html?program=9001&team=501', { waitUntil: 'networkidle0' });
check('team page shows record 8-1-1', (await page.content()).includes('8-1-1'));

await page.goto('http://localhost:8123/matchup.html?program=9001&team=501', { waitUntil: 'networkidle0' });
await page.select('#oppPicker', '502');
await new Promise((r) => setTimeout(r, 200));
check('matchup shows a probability bar', (await page.content()).includes('probbar'));

await page.goto('http://localhost:8123/player.html?person=1', { waitUntil: 'networkidle0' });
{
  const content = await page.content();
  check(
    'player card shows the first name but never renders fields outside its schema (e.g. an internal-only note)',
    content.includes('Sam') && !content.includes('internal-only'),
  );
}

await page.goto('http://localhost:8123/odds.html?program=9001', { waitUntil: 'networkidle0' });
{
  const content = await page.content();
  // Hand-computed from fixtures/data/standings/9001.json + activities/9001.json:
  // team 501 (8-1-1, +2 set diff over 1 game) rates 0.86; team 502 (6-3-1, -2 set diff) rates 0.64.
  // Both are within the top-CUTOFF(4) in this 2-team league, so both floor at >=50%; the cutoff
  // rating is the lowest-rated team's own rating (0.64), giving team 501 a gap of +0.22 -> 50+88=138,
  // clamped to 100%, and team 502 a gap of 0 -> exactly 50%.
  check('odds page shows the correct playoff percentage for the leader (100%)', content.includes('100%'));
  check('odds page shows the correct playoff percentage for the trailing team (50%)', content.includes('50%'));
}

check(`no uncaught page errors (${pageErrors} occurred)`, pageErrors === 0);

await browser.close();
server.close();

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all UI checks passed');
}
