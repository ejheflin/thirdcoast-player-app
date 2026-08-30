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
page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));

let failures = 0;
function check(label, cond) {
  console.log(cond ? `PASS ${label}` : `FAIL ${label}`);
  if (!cond) failures++;
}

await page.goto('http://localhost:8123/rankings.html?program=9001', { waitUntil: 'networkidle0' });
check('rankings shows Testers United', (await page.content()).includes('Testers United'));

await page.goto('http://localhost:8123/team.html?program=9001&team=501', { waitUntil: 'networkidle0' });
check('team page shows record 8-1-1', (await page.content()).includes('8-1-1'));

await page.goto('http://localhost:8123/matchup.html?program=9001&team=501', { waitUntil: 'networkidle0' });
await page.select('#oppPicker', '502');
await new Promise((r) => setTimeout(r, 200));
check('matchup shows a probability bar', (await page.content()).includes('probbar'));

await page.goto('http://localhost:8123/player.html?person=1', { waitUntil: 'networkidle0' });
check('player card shows first name only, never a last name', (await page.content()).includes('Sam') && !(await page.content()).includes('Samson'));

await page.goto('http://localhost:8123/odds.html?program=9001', { waitUntil: 'networkidle0' });
check('odds page shows a percentage', /\d+%/.test(await page.content()));

await browser.close();
server.close();

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all UI checks passed');
}
