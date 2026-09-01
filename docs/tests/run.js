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

// index.html is a ROUTER now, not a screen: it reads the program's
// schedule and only THEN navigates -- to gamenight.html, playoffs.html or
// search.html. For a saved team that decision comes after a fetch, so
// page.goto/waitForNavigation can resolve while the router is still
// mid-hop. Every entry through index.html therefore waits for it to
// actually land on one of its three destinations before anything is
// asserted about the page.
const ROUTED = ['/gamenight.html', '/playoffs.html', '/search.html'];
const settleRouter = async () => {
  for (let i = 0; i < 60; i++) {
    const here = await page.evaluate(() => location.pathname).catch(() => null);
    if (here && ROUTED.includes(here)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await page.waitForNetworkIdle({ idleTime: 250, timeout: 5000 }).catch(() => {});
};
// Opening the app the way a real returning player does -- the bare app
// root -- and waiting for the router to finish.
const goHome = async () => {
  await go('index.html').catch(() => {});
  await settleRouter();
};

// Every check below starts from a clean device: no saved team.
await go('search.html');
await page.evaluate(() => localStorage.clear());

// ---- displayTeamName (shared helper, app.js) -----------------------------
{
  const results = await page.evaluate(() => ([
    displayTeamName('1 - Bumpin Uglies (Matt O.)'),
    displayTeamName('1 - Bumpin Uglies (Matt O.)', { stripCaptain: true }),
    displayTeamName('(Lily P.)', { stripCaptain: true }),
    displayTeamName('1. Testers United'),
    displayTeamName('  '),
  ]));
  check(`displayTeamName strips the leading number only by default, got ${JSON.stringify(results[0])}`,
    results[0] === 'Bumpin Uglies (Matt O.)');
  check(`displayTeamName strips both leading number and trailing captain name when asked, got ${JSON.stringify(results[1])}`,
    results[1] === 'Bumpin Uglies');
  check(`displayTeamName guards a parenthetical-only name from becoming empty, got ${JSON.stringify(results[2])}`,
    results[2] === '(Lily P.)');
  check(`displayTeamName handles the ". " prefix style too, got ${JSON.stringify(results[3])}`,
    results[3] === 'Testers United');
  check(`displayTeamName never throws or returns non-string on blank input, got ${JSON.stringify(results[4])}`,
    typeof results[4] === 'string');
}

// ---- tab bar shape (3 tabs: home / ranks / schedule) ---------------------
await go('rankings.html?program=9001');
{
  const tabs = await page.$$eval('.tabbar .tab', (els) => els.map((el) => el.dataset.tab));
  check(`tab bar has exactly 3 tabs (home, ranks, schedule), got ${tabs.join(',')}`,
    tabs.join(',') === 'home,ranks,schedule');
}

// ---- page content -------------------------------------------------------
await go('search.html');
await page.type('#q', 'test', { delay: 20 });
await new Promise((r) => setTimeout(r, 300));
check('search finds Testers United for query "test"', (await page.content()).includes('Testers United'));
check(
  'search excludes teams that do not match the query',
  !(await page.content()).includes('Fixture FC'),
);
// The entry point must be able to scroll its results: 15 matches at ~72px
// each overflow any phone screen, and this page used to have no scroller.
check(
  'search results live in the scrollable .body pane',
  await page.$eval('#results', (el) => el.classList.contains('body') && getComputedStyle(el).overflowY === 'auto'),
);

await go('rankings.html?program=9001');
check('rankings shows Testers United', (await page.content()).includes('Testers United'));
check('rankings strips the leading seed number from the displayed name',
  !(await page.content()).includes('1. Testers United') && !(await page.content()).includes('1 - Testers United'));
{
  const underlined = await page.$$eval('.rank-row', (rows) =>
    rows.some((r) => getComputedStyle(r.closest('a') ?? r).textDecorationLine !== 'none'));
  check('rankings rows have no underline', !underlined);
}

await go('team.html?program=9001&team=501');
check('team page shows record 8-1-1', (await page.content()).includes('8-1-1'));
check('team page lists its roster by first name', (await page.content()).includes('Sam'));

{
  // Same fixture, same hand-computed numbers as the retired odds.html
  // page test used (94/50/-/50/1 for 501/502/503/507/506) -- team.html
  // now shows just ONE team's row per page instead of the whole table.
  const cases = [
    [501, '94%'], [502, '50%'], [507, '50%'], [506, '1%'],
  ];
  for (const [teamId, expected] of cases) {
    await go(`team.html?program=9001&team=${teamId}`);
    const pct = await page.$eval('.odds-pct', (el) => el.textContent.trim());
    check(`team ${teamId} page shows playoff odds ${expected}, got ${pct}`, pct === expected);
  }
  await go('team.html?program=9001&team=503');
  const rendered = await page.$eval('#body', (el) => el.innerText);
  check('team page for a 0-game team shows no odds percentage and no NaN',
    !rendered.includes('NaN') && !(await page.$('.odds-pct')));
}

{
  // team.html's old "Previous matches" card (viewer's saved team vs. this
  // page's team) was retired as redundant with the Opponents card: the
  // saved team is always in the same program as any team page reached by
  // real navigation, so it always already has its own Opponents row
  // showing the exact same head-to-head dots. This just guards the old
  // card stays gone rather than silently coming back -- the actual
  // dot/empty-state logic is covered by the Opponents-card checks above.
  await page.evaluate(() => localStorage.setItem(
    'thirdcoast-my-team',
    JSON.stringify({ programId: 9001, teamId: 501, teamName: '1. Testers United', programName: 'Test Tuesday League' }),
  ));
  await go('team.html?program=9001&team=502');
  check('team page has no separate "Previous matches vs. your saved team" card any more (superseded by Opponents)',
    (await page.$$('.sec-lbl')).length > 0 &&
    !(await page.evaluate(() => [...document.querySelectorAll('.sec-lbl')].some((el) => el.textContent.trim() === 'Previous matches'))));
}

{
  await go('team.html?program=9001&team=501');
  const gridCols = await page.$eval('.teamroster .rgrid', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length).catch(() => 0);
  check('team page roster renders as a 2-column grid', gridCols === 2);
}

// team.html's Opponents card -- one row per OTHER team in the standings
// (9001 has 6 teams total, so 501's page should show the other 5), sorted
// by power rank, captain-name-free, each linking to that team's own page.
{
  await go('team.html?program=9001&team=501');
  const oppRows = await page.$$eval('.opp-row', (rows) => rows.map((r) => ({
    name: r.querySelector('.nm').textContent.trim(),
    href: r.closest('a').getAttribute('href'),
    dots: [...r.querySelectorAll('.opp-dots i')].map((i) => i.className),
    dotsEmpty: r.querySelector('.opp-dots .opp-empty')?.textContent.trim() ?? null,
    hasBar: !!r.querySelector('.opp-bar'),
    oddsEmpty: r.querySelector('.opp-odds .opp-empty')?.textContent.trim() ?? null,
    pct: r.querySelector('.opp-pct')?.textContent.trim() ?? null,
  })));

  check(`Opponents card lists all 5 other teams, sorted by power rank (best record first), got ${JSON.stringify(oppRows.map((r) => r.name))}`,
    JSON.stringify(oppRows.map((r) => r.name)) ===
      JSON.stringify(['Fixture FC', 'Brand New Squad', 'Bubble FC', 'Net Prophets', 'Understrength Squad']));

  const fixtureFC = oppRows.find((r) => r.name === 'Fixture FC');
  check(`Opponents row for a team already played shows its real head-to-head dot(s), got ${JSON.stringify(fixtureFC?.dots)}`,
    JSON.stringify(fixtureFC?.dots) === JSON.stringify(['W']));
  check('Opponents row for a team already played shows an odds bar, not the empty state',
    fixtureFC?.hasBar && fixtureFC?.oddsEmpty === null && fixtureFC?.pct !== null);

  const bubbleFC = oppRows.find((r) => r.name === 'Bubble FC');
  check('Opponents row for a team not yet MET (but which has played other games) shows "not yet met" dots but a real odds bar',
    bubbleFC?.dotsEmpty === '—' && bubbleFC?.hasBar && bubbleFC?.pct !== null);

  const brandNew = oppRows.find((r) => r.name === 'Brand New Squad');
  check('Opponents row for a 0-game opponent shows the empty state in BOTH columns, not a bar (nothing to rate)',
    brandNew?.dotsEmpty === '—' && brandNew?.oddsEmpty === '—' && !brandNew?.hasBar);

  check('no Opponents row ever renders NaN%', !oppRows.some((r) => r.pct?.includes('NaN')));

  check('each Opponents row links to that team\'s own team.html page',
    fixtureFC?.href === 'team.html?team=502&program=9001');
}

// A team that has not played yet has no rating to divide by: the page must
// say so rather than rendering "NaN%".
{
  // Ported from the retired matchup.html's own "0-game team never
  // renders NaN" test -- same underlying splitPct guard, now exercised
  // through gamenight.html (the only page left that does a two-team
  // rating comparison) instead. Deliberately does NOT reuse team 503 (the
  // existing 0-game team) for this: 503 is load-bearing for the SEPARATE
  // "no upcoming game -> falls back to last result" coverage below, which
  // depends on 503 having NO entry in schedule/9001.json at all. Giving 503
  // a schedule entry here would silently break that other check instead
  // (confirmed by actually running the suite with that version -- "Home
  // falls back to the team's last played result" failed). So this uses a
  // brand-new synthetic 0-game team, 508, added to both
  // fixtures/data/standings/9001.json (position 6, gamesPlayed 0 -- clear
  // of the position-4 ODDS_CUTOFF the team.html odds tests depend on) and
  // fixtures/data/schedule/9001.json (one game vs. 502, dated LATER than
  // 501's existing games so it can't affect any test that counts cards on
  // 501's earliest date, or change 502's own next-game date elsewhere).
  await page.evaluate(() => localStorage.setItem(
    'thirdcoast-my-team',
    JSON.stringify({ programId: 9001, teamId: 508, teamName: '6. Understrength Squad', programName: 'Test Tuesday League' }),
  ));
  await goHome();
  const rendered0Game = await page.$eval('#body', (el) => el.innerText);
  check('Home never renders NaN for a 0-game team\'s own match card', !rendered0Game.includes('NaN'));
  check('Home explains why there is no prediction for a 0-game team',
    rendered0Game.includes('Not enough games played yet'));
}

await go('player.html?person=1');
{
  const content = await page.content();
  check(
    'player card shows the first name but never renders fields outside its schema (e.g. an internal-only note)',
    content.includes('Sam') && !content.includes('internal-only'),
  );
}

// ---- gamenight.html: the "next game" Home screen -------------------------
// Reached only through index.html below, never by typing its URL: the
// router is the real entry point and this suite's rule is to walk the
// path a player walks.
await page.evaluate(() => localStorage.clear());

// (c) No saved team -> straight to search, not a blank/broken state.
await goHome();
check('index.html with no saved team redirects to search.html', path() === '/search.html');
check('search.html (via the redirect) shows the search box', (await page.$('#q')) !== null);

// (a) A saved team with real upcoming games. Team 501 plays TWICE on
// 2026-09-10 in tests/fixtures/data/schedule/9001.json -- 7pm on Court 2
// vs. 502, then 8pm on Court 5 vs. 506 -- which is what a real league
// night looks like, and the whole reason Home groups by date instead of
// taking the first match it finds. Every rated team has played games in
// standings/9001.json, so the model has something to work from.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9001, teamId: 501, teamName: '1. Testers United', programName: 'Test Tuesday League' }),
));
await goHome();
check(
  `index.html routes a program with no playoff marker to gamenight.html, got ${path()}`,
  path() === '/gamenight.html?program=9001&team=501',
);
{
  const content = await page.content();
  check('Home renders one match card per game on the next scheduled date (2)',
    (await page.$$('.mgame')).length === 2);
  check('Home says how many matches that night', content.includes('2 matches'));

  // Both real opponents, in start-time order, and the player's own team in
  // the TOP slot of both cards. The second fixture game deliberately lists
  // team 506 FIRST in its raw `teams` array, so this fails if the page ever
  // falls back to array order instead of matching the saved team's id.
  const sides = await page.$$eval('.mgame', (cards) => cards.map(
    (c) => [...c.querySelectorAll('.side .tname')].map((el) => el.textContent.trim()),
  ));
  check('Home puts the player\'s own team on top of card 1, opponent below',
    sides[0][0] === 'Testers United' && sides[0][1] === 'Fixture FC');
  check('Home puts the player\'s own team on top of card 2 too, even though the raw data lists it second',
    sides[1][0] === 'Testers United' && sides[1][1] === 'Net Prophets');

  // The court slab carries the real court number and the venue's real
  // paint name for it, straight off the broadcast board's COURT table:
  // Court 2 is orange, Court 5 is dark green (and dark green is one of the
  // three courts under 3:1 against this ground, so its slab gets the sand
  // ring the board gives them -- the .faint class).
  const courts = await page.$$eval('.mgame', (cards) => cards.map((c) => ({
    num: c.querySelector('.cnum').textContent.trim(),
    // The paint name is no longer rendered as visible text (Eric: "purple"
    // and "pink" spelled out on the card are redundant with the slab's own
    // colour) but it stays recoverable in the DOM via data-paint on the
    // slab itself, so this coverage -- that the RIGHT court attached to
    // the RIGHT card -- survives unweakened.
    paint: c.querySelector('.slab').getAttribute('data-paint'),
    faint: c.querySelector('.mcard').classList.contains('faint'),
    fill: c.style.getPropertyValue('--ct').trim(),
  })));
  check('Home paints card 1 as Court 2 / orange (#F2872F), not faint',
    courts[0].num === '2' && courts[0].paint === 'orange' && courts[0].fill === '#F2872F' && !courts[0].faint);
  check('Home paints card 2 as Court 5 / dark green (#1F6B3A) with the sand ring',
    courts[1].num === '5' && courts[1].paint === 'dark green' && courts[1].fill === '#1F6B3A' && courts[1].faint);

  // The corner tag carries the real start time out of the schedule. The
  // day half is relative to today by design ("Today" / "Thu" / "Sep 10"),
  // so it is asserted by shape rather than as a fixed string that would
  // rot as the clock moves past the fixture date.
  const badges = await page.$$eval('.mgame .statetag', (els) => els.map((el) => el.textContent.trim()));
  check(`Home corner tags carry the real start times (7p, 8p), got ${badges.join(' | ')}`,
    badges[0].endsWith(' 7p') && badges[1].endsWith(' 8p'));
  check('Home corner tags name the day in one of the three real forms',
    badges.every((b) => /^(Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun|[A-Z][a-z]{2} \d{1,2}) /.test(b)));

  // Each card gets its OWN odds strip, with the real number in it -- not
  // just a probbar element. Hand-computed from the same fixtures odds.html's
  // block works from: 501 rates 0.86, 502 rates 0.64, 506 rates 0.34.
  //   card 1: 0.86 / (0.86 + 0.64) = 57.33 -> 57% / 43%
  //   card 2: 0.86 / (0.86 + 0.34) = 71.67 -> 72% / 28%
  // Two DIFFERENT splits, so this can't pass by rendering one card twice.
  const splits = await page.$$eval('.mgame', (cards) => cards.map(
    (c) => [...c.querySelectorAll('.modds .probbar > div')].map((el) => el.textContent.trim()).join('/'),
  ));
  check(`Home gives card 1 its own split of 57%/43%, got ${splits[0]}`, splits[0] === '57%/43%');
  check(`Home gives card 2 its own split of 72%/28%, got ${splits[1]}`, splits[1] === '72%/28%');

  // Head-to-head history for THIS matchup specifically -- one shared row
  // between the card and the odds strip, not one row per team (an earlier
  // draft of this feature showed each team's separate overall season form;
  // Eric corrected that to "for A vs B matches, there is only 1 row of
  // history needed"). fixtures/data/activities/9001.json gives one
  // populated case and one empty case for free: 501 and 502 have played
  // each other exactly once this season (501 won it), while 501 and 506
  // have never played each other (506's only recorded game is against
  // 999) -- so card 1 must show exactly one win-colored dot and card 2
  // must show the "not yet met" fallback, with no fixture edits needed.
  const h2h = await page.$$eval('.mgame .mform', (els) => els.map((el) => ({
    label: el.querySelector('.flbl')?.textContent.trim() ?? '',
    dots: [...el.querySelectorAll('.fdots i')].map((i) => i.className),
    empty: el.querySelector('.empty')?.textContent.trim() ?? null,
  })));
  check('Home labels the head-to-head row "Previous matches" on both cards',
    h2h.every((r) => r.label === 'Previous matches'));
  check(
    `card 1's head-to-head row shows exactly one win-colored dot for 501 vs 502 (their one real meeting), got ${JSON.stringify(h2h[0].dots)}`,
    h2h[0].dots.length === 1 && h2h[0].dots[0] === 'W',
  );
  check(
    `card 2's head-to-head row falls back to "not yet met" for 501 vs 506 (no game between them in the fixture), got ${JSON.stringify(h2h[1])}`,
    h2h[1].dots.length === 0 && h2h[1].empty === 'Not yet met this season.',
  );

  // ...and each card gets its own opponent roster, from that game's own
  // rosters/9001-{opponent}.json file.
  const rosters = await page.$$eval('.mgame', (cards) => cards.map((c) => ({
    label: c.querySelector('.mroster .rlbl')?.textContent.trim() ?? '',
    names: [...c.querySelectorAll('.mroster .roster-row .who')].map((el) => el.textContent.trim()).join(','),
  })));
  check('Home lists card 1\'s opponent roster by first name (9001-502.json)',
    rosters[0].label === 'Opponent roster' && rosters[0].names === 'Priya,Deshawn');
  check('Home lists card 2\'s own, different opponent roster (9001-506.json)',
    rosters[1].label === 'Opponent roster' && rosters[1].names === 'Marisol,Tobias');

  // Team names on the match card link to that team's own /team page --
  // both "my team" and the opponent, on both cards. Checked as real <a>
  // href attributes rather than by clicking through, so this doesn't
  // disturb the Home page state the checks right after it still need.
  const tnameLinks = await page.$$eval('.mgame .tname', (els) => els.map((el) => ({ tag: el.tagName, href: el.getAttribute('href') })));
  check(`Home match card team names are real links (<a href>), not spans, got ${JSON.stringify(tnameLinks)}`,
    tnameLinks.length === 4 && tnameLinks.every((l) => l.tag === 'A' && !!l.href));
  check('Home card 1: my own team name links to my own team page',
    tnameLinks[0].href === 'team.html?team=501&program=9001');
  check('Home card 1: opponent name links to their team page',
    tnameLinks[1].href === 'team.html?team=502&program=9001');
  check('Home card 2: opponent name links to their (different) team page',
    tnameLinks[3].href === 'team.html?team=506&program=9001');

  const rendered = await page.$eval('#body', (el) => el.innerText);
  check('Home never renders NaN in the probability split', !rendered.includes('NaN'));
  // Fix 2: search.html used to be reachable ONLY via the no-saved-team
  // redirect, leaving a player whose team changed with no route to it.
  check('Home offers a way back to search for a different team',
    await page.$eval('#searchAgain', (el) => el.getAttribute('href') === 'search.html'));
  check('Home links to Season stats for this team/program', await page.$eval(
    'a.textlink',
    (el) => el.getAttribute('href') === 'team.html?team=501&program=9001',
  ));
}

// (b) A saved team with an empty/no-matching schedule falls back to
// last-result content, not a blank page. Team 503 has no entry in
// schedule/9001.json but does have a real played game in activities/9001.json.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9001, teamId: 503, teamName: '3. Brand New Squad', programName: 'Test Tuesday League' }),
));
await goHome();
check('a team with no upcoming game of its own still routes to gamenight.html, which owns that fallback',
  path() === '/gamenight.html?program=9001&team=503');
{
  const content = await page.content();
  check('Home with no upcoming game says so plainly', content.includes('No game scheduled right now'));
  check('Home falls back to the team\'s last played result', content.includes('Last result') && content.includes('Bye Week Rivals'));
  check('Home still shows the team\'s current record in the fallback state', content.includes('0-0-0'));
  // This is the exact case the stale-pointer fix (above) was worried about
  // breaking: team 503 has a real standings row AND a real activities
  // history, so simply having no upcoming game must NOT be treated as
  // stale. The pointer has to survive this render untouched.
  const savedAfterFallback = await page.evaluate(() => localStorage.getItem('thirdcoast-my-team'));
  check(
    'Home does NOT clear the saved pointer for a valid team that just has no game scheduled right now',
    savedAfterFallback !== null && JSON.parse(savedAfterFallback).teamId === 503,
  );
}

// (d) Two winless teams, both with NEGATIVE ratings. Program 9002's
// fixture is built for exactly this: team 504 rates -0.05 (0 wins, -2 set
// diff over 2 games -> 0 + (-1 x 0.05)) and team 505 rates -0.20 (0 wins,
// -8 over 2 -> 0 + (-4 x 0.05)). The old ratingA/(ratingA+ratingB) split
// divided by a NEGATIVE sum (-0.25) and handed the clearly-better team 504
// just 20% -- the favorite inverted. Shifting both up by -min+0.01 = 0.21
// first gives 0.16 / 0.17 = 94.1% -> 94% to team 504 and 6% to team 505.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9002, teamId: 504, teamName: '1. Sandbar Sitters', programName: 'Winless Wednesday League' }),
));
await goHome();
{
  const cells = await page.$$eval('.probbar > div', (els) => els.map((el) => el.textContent.trim()));
  check('Home favors the better of two winless teams (94% / 6%), not the worse one', cells[0] === '94%' && cells[1] === '6%');
  check('Home no longer shows the inverted 20% the old negative-rating formula gave team 504', cells[0] !== '20%');
}

// ---- index.html as a ROUTER, and playoffs.html ---------------------------
// index.html used to BE the game-night screen. It is now a thin router
// over the `tournaments` markers archive/schedule.js captures, and the
// four blocks below are its whole decision table. (a) above already
// covers "no marker at all -> game night"; these cover the rest.

// (e) A real playoff marker dated the SAME DAY as the program's next
// game: playoff night wins. Program 9003's fixture is exactly that shape
// -- the real one at this venue, where the final league night and the
// bracket share a date -- so this is what proves the router compares "on
// or before" rather than "strictly before".
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9003, teamId: 601, teamName: '1. Bracket Bound', programName: 'Playoff Thursday League' }),
));
await goHome();
check(
  `index.html routes a program whose playoff marker is next to playoffs.html, got ${path()}`,
  path() === '/playoffs.html?program=9003&team=601',
);
{
  // Rendered text, not page.content(): the page's own source comments and
  // date-formatting code mention these words, so a substring search of the
  // raw HTML could pass without the branch ever having run.
  const rendered = await page.$eval('#body', (el) => el.innerText);
  check(
    `playoffs.html renders the real tournament date from the data (Thursday, March 11), got ${JSON.stringify(rendered.slice(0, 60))}`,
    rendered.includes('Thursday, March 11'),
  );
  check('playoffs.html renders the real tournament start time (18:30 -> 6:30 PM)', rendered.includes('6:30 PM'));
  check('playoffs.html carries the marker\'s own title from the data', rendered.includes('PLAYOFFS'));
  check(
    'playoffs.html is honest about having no live playoff data, and names where the real bracket is',
    rendered.includes("venue's TV board") && rendered.includes("doesn't have live playoff data yet"),
  );
  check(
    'playoffs.html names the program in its topbar',
    (await page.$eval('#greet', (el) => el.textContent.trim())) === 'Playoff Thursday League',
  );
  // The dead-end mistake this project already made once: a screen whose
  // Home tab is rendered as the active tab has a null onclick and no way
  // back at all. playoffs.html is a stub, which makes a way OUT of it the
  // single most important thing on the page.
  check(
    'playoffs.html Home tab is a live link, not the active/disabled tab',
    await page.$eval('.tab[data-tab="home"]', (el) => !el.classList.contains('on') && !el.classList.contains('off')),
  );
  check(
    'playoffs.html offers in-page routes to real archived data too',
    (await page.$$eval('a.textlink', (els) => els.map((el) => el.getAttribute('href')))).join(' ')
      === 'team.html?team=601&program=9003 rankings.html?program=9003',
  );
}

// ...and the Home tab goes back THROUGH index.html, which re-decides --
// so the same tab lands on game night once playoffs are over, with no
// change to this page. Every main-frame navigation is recorded, rather
// than asserting on an intermediate URL, because the router's forward hop
// can outrun a waitForNavigation.
{
  const visited = [];
  const record = (frame) => { if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname); };
  page.on('framenavigated', record);
  await clickThrough('.tab[data-tab="home"]');
  await settleRouter();
  page.off('framenavigated', record);
  check(`playoffs.html Home tab routes back through index.html, the router (visited ${visited.join(' -> ')})`,
    visited.includes('/index.html'));
  check('...and the router puts this player back on playoff night', path() === '/playoffs.html?program=9003&team=601');
}

// (f) A real playoff marker that is still WEEKS out, behind the next game
// night. A marker existing must not be enough on its own: program 9004
// has one dated 2027-04-08 and a game on 2027-03-11, and game night wins.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9004, teamId: 701, teamName: '1. Still Playing', programName: 'Mid Season League' }),
));
await goHome();
check(
  `a playoff marker dated after the next game night must not hijack game night, got ${path()}`,
  path() === '/gamenight.html?program=9004&team=701',
);
check('and that game night screen really rendered its match card', (await page.$$('.mgame')).length === 1);

// (g) A marker and NO remaining games at all -- the real live shape of a
// program whose league nights have run out (verified against the live
// site: Wednesday Mens 2s AA, playoffs 2026-09-02, zero games left).
// 9005 also has no standings file, so this doubles as the check that
// playoffs.html degrades to the saved program name instead of erroring.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9005, teamId: 801, teamName: '1. Season Over', programName: 'Bracketless Wednesday League' }),
));
await goHome();
check(
  `a playoff marker with no games left routes to playoffs.html, got ${path()}`,
  path() === '/playoffs.html?program=9005&team=801',
);
{
  const rendered = await page.$eval('#body', (el) => el.innerText);
  check('playoffs.html renders its real date even for a program with no standings file', rendered.includes('Thursday, March 18'));
  check('playoffs.html renders a noon start as 12:00 PM, not 0:00 PM', rendered.includes('12:00 PM'));
  check(
    'playoffs.html falls back to the saved program name when there is no standings file',
    (await page.$eval('#greet', (el) => el.textContent.trim())) === 'Bracketless Wednesday League',
  );
}

await page.evaluate(() => localStorage.clear());

// ---- navigation: every page reachable using only in-app links -----------
// Nothing below types a URL; each step clicks what a real player would.
await go('search.html');
await page.evaluate(() => localStorage.clear());
await go('search.html');
await page.type('#q', 'testers', { delay: 20 });
await new Promise((r) => setTimeout(r, 300));
await clickThrough('.result');
check('search result -> team page', path().startsWith('/team.html') && path().includes('team=501'));

// team.html is NOT Home any more -- Home is index.html, the router, which
// lands a regular-season player on gamenight.html, the next-game feed.
// It used to pass active:'home' to wireTabs, which renders Home as the tab
// you're already on and (by wireTabs' own rule) gives the active tab a null
// onclick: a navigation dead end with no way back to Home at all.
check(
  'team page Home tab is a live link, not rendered as the active/disabled tab',
  await page.$eval('.tab[data-tab="home"]', (el) => !el.classList.contains('on') && !el.classList.contains('off')),
);
await clickThrough('.tab[data-tab="home"]');
await settleRouter();
check('team page Home tab -> index.html, which routes on to the game-night screen',
  path() === '/gamenight.html?program=9001&team=501');

// ...and back to the team page the way a player gets there now: the Home
// screen's own "Season stats" link.
await clickThrough('a.textlink');
check('Home Season stats link -> team page', path().startsWith('/team.html') && path().includes('team=501'));

await clickThrough('.tab[data-tab="ranks"]');
check('team page Ranks tab -> rankings', path() === '/rankings.html?program=9001');

await go('team.html?program=9001&team=501');
{
  const scheduleHref = await page.$eval('.tab[data-tab="schedule"]', (el) => el.onclick ? 'has-onclick' : 'none');
  check('team page Schedule tab is a live link once a program is in context', scheduleHref === 'has-onclick');
}
// Restore the page the surrounding flow-test sequence expects to be on:
// the schedule-tab check above navigated to team.html, and the next step
// (clicking a rankings row) needs to be back on rankings.html.
await go('rankings.html?program=9001');

await clickThrough('.row-link');
check('rankings row -> team page (the drill-down the spec describes)', path().startsWith('/team.html'));

// Scoped to .teamroster specifically -- team.html's Opponents card (above
// the roster in the DOM) is now ALSO full of .card .row-link elements
// (each opponent row links to that team's own page), so the old bare
// '.card .row-link' selector would hit an opponent row first instead.
await clickThrough('.teamroster .row-link');
check('team roster row -> player card', path() === '/player.html?person=1');

// Home now lands on the next-game feed itself, not a forward straight to
// team.html -- that forwarding behavior moved off this page.
await clickThrough('.tab[data-tab="home"]');
await settleRouter();
check('player card Home tab -> the Home (next-game) screen', path() === '/gamenight.html?program=9001&team=501');

// The rare-use escape hatch: a player whose team situation changed can get
// back to search without clearing site data by hand.
await clickThrough('#searchAgain');
check('Home "Not your team? Search again" -> search.html', path() === '/search.html');
check('the search-again link lands on a working search box', (await page.$('#q')) !== null);

// ---- a stale saved team must recover, not bounce forever ----------------
// Entered the way a real returning player hits it, per this suite's rule
// that nothing types a URL. This block used to start with
// go('team.html?team=8888&program=9999') -- a deep link no player could
// type -- and that is precisely why it missed the regression: the Home
// screen stopped forwarding a saved team to team.html, so team.html's
// cleanup was no longer anywhere on the path a real player walks. The
// Home screen has to recover the pointer itself now, and this proves it
// does -- entered through index.html, the router, exactly as a player
// hits it.
await go('search.html');
await page.evaluate(() => localStorage.clear());
await go('search.html');
await page.type('#q', 'testers', { delay: 20 });
await new Promise((r) => setTimeout(r, 300));
await clickThrough('.result'); // a real save, made by a real click

// The device state a returning player actually shows up with months later:
// the pointer they saved, to a program that has since gone away. Only the
// stored value is faked here -- no navigation, no typed URL.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9999, teamId: 8888, teamName: 'Gone Team', programName: 'Dead League' }),
));

// Their browser opens the app root on its own (bookmark / home-screen
// icon). Every step from there is a real click, and they are counted.
let staleClicks = 0;
const staleClick = async (selector) => { staleClicks++; await clickThrough(selector); };
await go('');
await settleRouter();
check('a dead program with no schedule file still routes somewhere real, not a stuck router',
  path() === '/gamenight.html?program=9999&team=8888');
// Rendered text, not page.content(): the raw HTML includes gamenight.html's own
// inline <script> source, so a plain string.includes() against it can pass
// purely because the source code MENTIONS these words, whether or not the
// branch that renders them into #body ever actually ran.
{
  const renderedStale = await page.$eval('#body', (el) => el.innerText);
  check('a stale saved team is handled on the Home screen itself', renderedStale.includes('find this team'));
  check(
    'the Home screen offers the way out, not a "check back after the next archive run" dead end',
    !renderedStale.includes('check back after the next archive run'),
  );
}
check(
  'the Home screen clears the stale pointer itself, without a trip through team.html',
  (await page.evaluate(() => localStorage.getItem('thirdcoast-my-team'))) === null,
);
await staleClick('a[href="search.html"]');
check('search is reachable from the stale-team message', path() === '/search.html');
check('and that search page actually works', (await page.$('#q')) !== null);
check(
  `stale-team recovery costs ${staleClicks} real click(s) from app open, not the old 4 hops`,
  staleClicks <= 1,
);

// ---- schedule.html --------------------------------------------------------
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9010, teamId: 701, teamName: '1. Spike Force', programName: 'Schedule Test League' }),
));
await go('schedule.html?program=9010');
{
  const dateHeaders = await page.$$eval('.sec-lbl', (els) => els.map((el) => el.textContent.trim()));
  check(`schedule groups games under a header per date, got ${JSON.stringify(dateHeaders)}`,
    dateHeaders.length === 2 || dateHeaders.length === 3);

  const rows = await page.$$eval('.sched-row', (els) => els.map((el) => {
    const badge = el.querySelector('.sched-court-badge');
    return {
      opp: el.querySelector('.sched-opp')?.textContent.trim() ?? '',
      rec: el.querySelector('.sched-rec')?.textContent.trim() ?? '',
      badgeNum: badge?.textContent.trim() ?? '',
      badgeBg: badge ? getComputedStyle(badge).backgroundColor : '',
      badgeFaint: badge?.classList.contains('faint') ?? false,
    };
  }));
  check(`schedule lists all 3 remaining games, got ${rows.length}`, rows.length === 3);
  check('schedule shows the opponent name without the leading seed number',
    rows.some((r) => r.opp === 'Net Ninjas') && rows.some((r) => r.opp === 'Ace Ventura') && rows.some((r) => r.opp === 'Block Party'));
  check('schedule shows each opponent\'s real record',
    rows.some((r) => r.rec === '6-2-0') && rows.some((r) => r.rec === '4-4-0') && rows.some((r) => r.rec === '2-6-0'));

  // Same COURT paint table as the match card: Court 3 vs. Net Ninjas is
  // blue (#2F72C4), Court 1 vs. Ace Ventura is lime green (#8CC63F, the
  // brand win color -- happens to share it, unrelated to result color).
  const netNinjas = rows.find((r) => r.opp === 'Net Ninjas');
  check(`schedule paints Court 3 (Net Ninjas) blue, got badge "${netNinjas?.badgeNum}" / ${netNinjas?.badgeBg}`,
    netNinjas?.badgeNum === '3' && netNinjas?.badgeBg === 'rgb(47, 114, 196)');
  const aceVentura = rows.find((r) => r.opp === 'Ace Ventura');
  check(`schedule paints Court 1 (Ace Ventura) lime green, got badge "${aceVentura?.badgeNum}" / ${aceVentura?.badgeBg}`,
    aceVentura?.badgeNum === '1' && aceVentura?.badgeBg === 'rgb(140, 198, 63)');
  const blockParty = rows.find((r) => r.opp === 'Block Party');
  check('schedule paints Court 4 (Block Party) maroon with the sand ring (a faint court)',
    blockParty?.badgeNum === '4' && blockParty?.badgeBg === 'rgb(142, 47, 63)' && blockParty?.badgeFaint === true);

  const rendered = await page.$eval('#body', (el) => el.innerText);
  check('schedule includes the season playoff marker', rendered.includes('PLAYOFFS'));
}

await clickThrough('.sched-row a, a.row-link');
check('schedule row -> that opponent\'s team page', path().startsWith('/team.html') && path().includes('program=9010'));

check(`no uncaught page errors (${pageErrors} occurred)`, pageErrors === 0);

await browser.close();
server.close();

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all UI checks passed');
}
