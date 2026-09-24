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
  check(`tab bar has exactly 4 tabs (home, court, ranks, schedule), got ${tabs.join(',')}`,
    tabs.join(',') === 'home,court,ranks,schedule');
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
    // .nmt, not .nm: .nm also holds the promoted/moved-down badge.
    name: r.querySelector('.nm .nmt').textContent.trim(),
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

// ---- the nav is a floating glass island ---------------------------------
// Design decision 2026-09-20: the bottom nav detaches from the screen edge
// and floats as a rounded, blurred island with the body scrolling visibly
// underneath it. Two things have to stay true for that to be an
// improvement rather than a regression:
//   * it must be inset on every side, so it reads as deliberately floating
//     rather than as the safe-area bug that was fixed earlier the same day;
//   * the body must reserve clearance for it, or the last row of every
//     page sits permanently under the island and cannot be scrolled clear.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9001, teamId: 501, teamName: '1. Testers United', programName: 'Test Tuesday League' }),
));
await goHome();
{
  const box = await page.evaluate(() => {
    const screenEl = document.querySelector('.screen');
    const tabbar = document.querySelector('.tabbar');
    const body = document.querySelector('.body');
    const cs = getComputedStyle(tabbar);
    const sr = screenEl.getBoundingClientRect();
    const tr = tabbar.getBoundingClientRect();
    // Scroll to the very bottom: clearance only matters once a player has
    // actually reached the end of the feed.
    body.scrollTop = body.scrollHeight;
    const last = body.lastElementChild;
    return {
      position: cs.position,
      radius: parseFloat(cs.borderRadius),
      hasBlur: (cs.backdropFilter || cs.webkitBackdropFilter || 'none') !== 'none',
      insetLeft: Math.round(tr.left - sr.left),
      insetRight: Math.round(sr.right - tr.right),
      insetBottom: Math.round(sr.bottom - tr.bottom),
      tabbarTop: Math.round(tr.top),
      lastChildBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
      bodyPadBottom: parseFloat(getComputedStyle(body).paddingBottom),
    };
  });

  check(`the nav island is absolutely positioned inside .screen, got ${box.position}`,
    box.position === 'absolute');
  check(`the nav island is inset from both sides (got left ${box.insetLeft}, right ${box.insetRight})`,
    box.insetLeft > 0 && box.insetRight > 0);
  check(`the nav island floats clear of the bottom edge, got ${box.insetBottom}px`,
    box.insetBottom > 0);
  check(`the nav island is fully rounded, got ${box.radius}px`, box.radius >= 16);
  check('the nav island applies a backdrop blur', box.hasBlur);

  // The regression this guards: with the island overlaying the body, a
  // body that does not pad for it hides its own last row forever.
  check(`the body reserves clearance for the island (padding-bottom ${box.bodyPadBottom}px)`,
    box.bodyPadBottom >= 60);
  check(`scrolled to the end, the last content clears the island (content bottom ${box.lastChildBottom} vs island top ${box.tabbarTop})`,
    box.lastChildBottom !== null && box.lastChildBottom <= box.tabbarTop);
}

// ---- the tab bar is icon-only ------------------------------------------
// The visible labels were removed (2026-09-20). Two things have to hold:
// the glyphs have to grow to carry the meaning on their own, and the tabs
// must keep an ACCESSIBLE name -- these are plain divs with no role, so
// stripping the text without aria-label would leave them unidentifiable.
{
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.tabbar .tab')].map((t) => ({
    name: t.dataset.tab,
    visibleText: t.textContent.trim(),
    aria: t.getAttribute('aria-label'),
    title: t.getAttribute('title'),
    iconW: Math.round(t.querySelector('.icon').getBoundingClientRect().width),
    hitW: Math.round(t.getBoundingClientRect().width),
  })));
  check(`no tab renders visible label text, got ${JSON.stringify(tabs.map((t) => t.visibleText))}`,
    tabs.every((t) => t.visibleText === ''));
  check(`every tab keeps an accessible name, got ${JSON.stringify(tabs.map((t) => t.aria))}`,
    tabs.length === 4 && tabs.every((t) => t.aria && t.aria.length > 0));
  check('every tab keeps a hover title too', tabs.every((t) => t.title === t.aria));
  check(`the glyphs grew to carry the meaning alone, got ${tabs[0].iconW}px`,
    tabs.every((t) => t.iconW >= 25));
  // Losing the label must not shrink what a thumb has to hit.
  check(`each tab is still a full third of the island wide, got ${JSON.stringify(tabs.map((t) => t.hitW))}`,
    tabs.every((t) => t.hitW > 80));
}

// ---- the active tab reads as a volleyball -------------------------------
// The ball is drawn as an inline SVG on .tab.on::before, behind the glyph.
{
  const ball = await page.evaluate(() => {
    const on = document.querySelector('.tab.on');
    const cs = getComputedStyle(on, '::before');
    const w = parseFloat(cs.width);
    const h = parseFloat(cs.height);
    const tab = on.getBoundingClientRect();
    const icon = on.querySelector('.icon').getBoundingClientRect();
    const cx = tab.left + tab.width / 2;
    const cy = tab.top + tab.height / 2;
    const box = { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
    return {
      w, h, content: cs.content,
      square: Math.abs(w - h) < 0.5,
      // Encloses the glyph with visible ring showing on every side --
      // a ball the same size as the glyph would just read as a border.
      ringGap: Math.round(Math.min(icon.top - box.top, box.bottom - icon.bottom,
        icon.left - box.left, box.right - icon.right)),
      inactive: getComputedStyle(document.querySelector('.tab:not(.on)'), '::before').content,
    };
  });

  check(`the active tab draws a ball, got content ${ball.content}`, ball.content === '""');
  check(`the ball is a circle, got ${ball.w}x${ball.h}`, ball.square && ball.w >= 40);
  check(`the ball clears the glyph on every side, tightest gap ${ball.ringGap}px`,
    ball.ringGap >= 4);
  check(`an inactive tab draws no ball, got ${ball.inactive}`,
    ball.inactive === 'none' || ball.inactive === '');
}

// ...and the clearance is scoped to pages that actually HAVE an island.
// search.html and index.html carry a .body and no .tabbar, so a blanket
// padding-bottom left ~94px of dead space under the last search result.
await go('search.html');
{
  const pad = await page.$eval('.body', (el) => parseFloat(getComputedStyle(el).paddingBottom));
  const hasBar = await page.$('.tabbar');
  check(`search.html has no nav island to clear, so reserves no clearance (padding-bottom ${pad}px)`,
    hasBar === null && pad < 40);
}

// ---- scroll containment -------------------------------------------------
// Reported 2026-09-20: on the installed iOS PWA, pulling DOWN at the top of
// the feed locked scrolling entirely for several seconds -- neither
// direction worked until the screen was left alone.
//
// Measured cause: .body is the only real scroller, the document is NOT
// scrollable (.screen is position:fixed, so the body element is literally
// 0px tall), and overscroll-behavior-y was `auto` everywhere -- the default,
// which ENABLES scroll chaining. At scrollTop 0 the pane has nothing left
// to consume, so the pull-down chains out of it into the document. iOS
// still grants a rubber-band gesture to a non-scrollable document, and once
// WebKit binds the touch sequence to that scroller the pane stops
// responding until the gesture and its momentum settle.
//
// These assertions cannot reproduce the iOS gesture binding -- no headless
// browser can -- but they lock in the property that stops the chain, which
// is the part that regressed silently for weeks.
// Needs a page with a real feed: the preceding block leaves search.html
// loaded, whose results pane is empty and therefore not scrollable at all.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9001, teamId: 501, teamName: '1. Testers United', programName: 'Test Tuesday League' }),
));
await goHome();
{
  const s = await page.evaluate(() => {
    const pane = document.querySelector('.body');
    const de = document.documentElement;
    return {
      pane: getComputedStyle(pane).overscrollBehaviorY,
      html: getComputedStyle(de).overscrollBehaviorY,
      body: getComputedStyle(document.body).overscrollBehaviorY,
      paneScrollable: pane.scrollHeight > pane.clientHeight + 1,
      docScrollable: de.scrollHeight > de.clientHeight + 1,
    };
  });
  check(`the scrolling pane does not chain its overscroll to the document, got ${s.pane}`,
    s.pane === 'contain' || s.pane === 'none');
  check(`the document itself refuses the rubber-band gesture (html), got ${s.html}`,
    s.html === 'none');
  check(`...and on body too, got ${s.body}`, s.body === 'none');
  // Guard the fix does not accidentally kill the thing it protects.
  check('the pane is still the real scroller and the document still is not',
    s.paneScrollable && !s.docScrollable);
}

// ---- court.html: the venue floor ---------------------------------------
// A port of the broadcast board's courtmap. The fixture night is dated
// 2099 on purpose, so the suite never depends on what "today" is; the
// clock logic is unit-tested separately below against a synthetic night.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9001, teamId: 501, teamName: '1. Testers United', programName: 'Test Tuesday League' }),
));
await go('court.html');
await new Promise((r) => setTimeout(r, 400));
{
  const floor = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.bankcol')].map((c) => ({
      label: c.querySelector('.bank-label').textContent.trim(),
      courts: [...c.querySelectorAll('.court-card')].map((b) => Number(b.dataset.court)),
    }));
    return {
      cols,
      total: document.querySelectorAll('.court-card').length,
      open: [...document.querySelectorAll('.court-card.open')].map((b) => Number(b.dataset.court)),
      mine: [...document.querySelectorAll('.court-card.mine')].map((b) => Number(b.dataset.court)),
      slots: [...document.querySelectorAll('.slot')].map((s) => s.textContent.trim()),
      onSlot: document.querySelector('.slot.on')?.textContent.trim(),
    };
  });

  // The whole reason this is a MAP: the board's physical arrangement.
  check(`the floor keeps the venue's real banks, got ${JSON.stringify(floor.cols.map((c) => c.label))}`,
    JSON.stringify(floor.cols.map((c) => c.label)) === JSON.stringify(['North', 'Center', 'South']));
  check(`north bank is 8-12, got ${floor.cols[0].courts.join(',')}`,
    floor.cols[0].courts.join(',') === '8,9,10,11,12');
  check(`centre is 6-7, got ${floor.cols[1].courts.join(',')}`,
    floor.cols[1].courts.join(',') === '6,7');
  check(`south bank is 1-5, got ${floor.cols[2].courts.join(',')}`,
    floor.cols[2].courts.join(',') === '1,2,3,4,5');
  check(`all 12 courts are on the floor, got ${floor.total}`, floor.total === 12);

  // An unused court stays as an outline -- dropping it would leave a hole
  // where a real court is, which defeats the orientation the map is for.
  check(`the 9 courts with no game render as open, got ${JSON.stringify(floor.open)}`,
    JSON.stringify(floor.open.sort((a, b) => a - b)) === JSON.stringify([2, 3, 4, 5, 6, 7, 9, 10, 11]));

  // The saved team is on court 8 in this slot.
  check(`the player's own court is marked, got ${JSON.stringify(floor.mine)}`,
    JSON.stringify(floor.mine) === JSON.stringify([8]));

  check(`the slot toggle lists every slot, got ${JSON.stringify(floor.slots)}`,
    floor.slots.length === 2 && floor.slots[0].startsWith('6:30') && floor.slots[1].startsWith('7:30'));
  check(`a night that is not today opens on its first slot, got ${floor.onSlot}`,
    floor.onSlot.startsWith('6:30'));
}

{
  // Ask #1: the floor cards carry the team names, in the big card's own
  // slab-and-teams shape, rather than just a colour chip and a league.
  const onFloor = await page.evaluate(() => {
    const c = document.querySelector('.court-card[data-court="8"]');
    return {
      slab: c.querySelector('.cslab')?.textContent.trim(),
      names: [...c.querySelectorAll('.ctname')].map((e) => e.textContent.trim()),
      mine: [...c.querySelectorAll('.ctname.mine')].map((e) => e.textContent.trim()),
    };
  });
  check(`a floor card shows both team names, got ${JSON.stringify(onFloor.names)}`,
    JSON.stringify(onFloor.names) === JSON.stringify(['Testers United', 'Brand New Squad']));
  check(`...beside the painted slab, got ${onFloor.slab}`, onFloor.slab === '8');
  check(`...with your own team picked out, got ${JSON.stringify(onFloor.mine)}`,
    JSON.stringify(onFloor.mine) === JSON.stringify(['Testers United']));
}

{
  // Ask #2: tapping opens the FULL match card -- the same component the
  // Home screen renders for your own game, odds and head-to-head and
  // rosters included -- not a summary. It loads async, hence the wait.
  await page.waitForSelector('#detail .mgame', { timeout: 6000 });
  const card = await page.evaluate(() => {
    const g = document.querySelector('#detail .mgame');
    return {
      names: [...g.querySelectorAll('.tname')].map((e) => e.textContent.trim()),
      court: g.querySelector('.cnum')?.textContent.trim(),
      paint: g.querySelector('.slab')?.getAttribute('data-paint'),
      formLabel: g.querySelector('.flbl')?.textContent.trim(),
      odds: [...g.querySelectorAll('.probbar > div')].map((e) => e.textContent.trim()),
      oddsNote: g.querySelector('.modds .h2h-meta')?.textContent.trim() ?? '',
      rosterLabels: [...g.querySelectorAll('.mroster .rlbl')].map((e) => e.textContent.trim()),
      when: g.querySelector('.statetag')?.textContent.trim() ?? '',
    };
  });
  check(`tapping opens the full match card with your team on top, got ${JSON.stringify(card.names)}`,
    card.names[0] === 'Testers United');
  check(`the card carries the painted court slab, got ${card.court}/${card.paint}`,
    card.court === '8' && card.paint === 'pink');
  check(`the card carries the previous-matches strip, got ${card.formLabel}`,
    card.formLabel === 'Previous matches');
  // 503 has played no games in the fixture, so this match legitimately
  // has no prediction -- either a real split or the honest explanation.
  check(`the card carries the odds strip, got ${JSON.stringify(card.odds)} ${JSON.stringify(card.oddsNote)}`,
    card.odds.length === 2 || card.oddsNote.includes('Not enough games'));
  check(`the card carries the slot time, got ${JSON.stringify(card.when)}`, card.when.includes('6:30'));
  check(`with your team in the match the roster shown is the OPPONENT's, got ${JSON.stringify(card.rosterLabels)}`,
    JSON.stringify(card.rosterLabels) === JSON.stringify(['Opponent roster']));
}

{
  // A neutral match -- the saved team is not on court 1 -- keeps the
  // data's own order and labels BOTH rosters by team, because with no
  // "you" in the match there is no "opponent" either.
  await page.click('.court-card[data-court="1"]');
  await page.waitForFunction(() => document.querySelector('#detail .cnum')?.textContent.trim() === '1', { timeout: 6000 });
  const neutral = await page.evaluate(() => {
    const g = document.querySelector('#detail .mgame');
    return {
      names: [...g.querySelectorAll('.tname')].map((e) => e.textContent.trim()),
      rosterLabels: [...g.querySelectorAll('.mroster .rlbl')].map((e) => e.textContent.trim()),
    };
  });
  check(`a neutral match keeps the data's own order, got ${JSON.stringify(neutral.names)}`,
    JSON.stringify(neutral.names) === JSON.stringify(['Fixture FC', 'Net Prophets']));
  check(`...and labels both rosters by team rather than "opponent", got ${JSON.stringify(neutral.rosterLabels)}`,
    JSON.stringify(neutral.rosterLabels) === JSON.stringify(['Fixture FC', 'Net Prophets']));

  await page.click('.court-card[data-court="3"]');
  await new Promise((r) => setTimeout(r, 350));
  const open = await page.$eval('#detail', (el) => el.innerText);
  check('tapping an unused court says so rather than leaving the last card up',
    open.includes('Nothing scheduled') && !open.includes('Fixture FC'));
}

{
  // A different slot must actually re-render the floor, not repaint it.
  await page.click('.slot[data-slot="1"]');
  await new Promise((r) => setTimeout(r, 150));
  const after = await page.evaluate(() => ({
    onSlot: document.querySelector('.slot.on')?.textContent.trim(),
    open: [...document.querySelectorAll('.court-card.open')].map((b) => Number(b.dataset.court)).sort((a, b) => a - b),
  }));
  check(`tapping a slot selects it, got ${after.onSlot}`, after.onSlot.startsWith('7:30'));
  check(`the second slot shows its own, different floor (only court 6 in play), got ${JSON.stringify(after.open)}`,
    after.open.length === 11 && !after.open.includes(6));
}

{
  // The clock logic, unit-tested against a synthetic night rather than
  // against fixture dates -- 24 hourly slots starting at midnight means
  // the live slot must be exactly the current hour, whenever this runs.
  const clock = await page.evaluate(() => {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hourly = { date: today, slots: Array.from({ length: 24 }, (_, h) => ({ time: `${pad(h)}:00`, courts: [] })) };
    const notToday = { date: '2099-03-10', slots: hourly.slots };
    return {
      hour: d.getHours(),
      liveToday: liveSlotIndex(hourly),
      liveOther: liveSlotIndex(notToday),
      defaultOther: defaultSlotIndex(notToday),
    };
  });
  check(`the live slot is the one containing now (hour ${clock.hour}), got ${clock.liveToday}`,
    clock.liveToday === clock.hour);
  check(`a night that is not today has no live slot, got ${clock.liveOther}`, clock.liveOther === null);
  check(`...and opens on its first slot, got ${clock.defaultOther}`, clock.defaultOther === 0);
}

{
  // The room's landmarks under courts 6-7: an L-shaped bar (bottom row
  // plus column 1's lower three cells of a 4x4 box) and the entrance
  // between the north bank and the bar, both labeled.
  const venue = await page.evaluate(() => {
    const v = document.querySelector('.bankcol.center .venue');
    if (!v) return null;
    const r = (sel) => v.querySelector(sel).getBoundingClientRect();
    const box = r('.venue-box'), up = r('.bar-up'), run = r('.bar-run'), ent = r('.entrance');
    const north = document.querySelector('.court-card[data-court="12"]').getBoundingClientRect();
    const cell = box.height / 4;
    const near = (a, b) => Math.abs(a - b) < 2.5;
    return {
      square: near(box.width, box.height),
      runIsBottomRow: near(run.top, box.bottom - cell) && near(run.width, box.width - 2),
      upIsCol1Rows23: near(up.left, box.left + 1) && near(up.top, box.top + cell) && near(up.bottom, run.top),
      entranceBetween: ent.left >= north.right && ent.right <= up.left && near(ent.top, box.top + cell),
      levelWith12: near(box.bottom, north.bottom),
      labels: [v.querySelector('.bar-run').textContent.trim(), v.querySelector('.entrance').textContent.trim()],
    };
  });
  check(`the venue box is a square with the L-shaped bar, got ${JSON.stringify(venue)}`,
    venue?.square && venue.runIsBottomRow && venue.upIsCol1Rows23);
  check('the entrance sits between the north courts and the bar, level with its upright', venue?.entranceBetween);
  check('the box sits level with the bottom of the banks', venue?.levelWith12);
  check('bar and entrance are labeled', JSON.stringify(venue?.labels) === JSON.stringify(['Bar', 'Entrance']));
}

{
  // The locked-phone bug: open at 7:30, lock, unlock at 9:30 -- the live
  // dot must move the moment the page is visible again, not on whatever
  // tick of a suspended timer comes next. Simulated with a synthetic
  // tonight holding a slot for every hour, the page left pointing at a
  // stale slot, and a visibilitychange standing in for the unlock.
  const res = await page.evaluate(() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    NIGHT = {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      slots: Array.from({ length: 24 }, (_, h) => ({ time: `${pad(h)}:00`, courts: [] })),
    };
    const staleHour = (d.getHours() + 12) % 24;
    slotIndex = staleHour; userPickedSlot = true; lastLive = staleHour; render();
    const dotAt = () => [...document.querySelectorAll('.slot')].findIndex((s) => s.querySelector('.livedot'));
    const onAt = () => [...document.querySelectorAll('.slot')].findIndex((s) => s.classList.contains('on'));
    // Force the stale picture the bug report describes: dot on the old slot.
    document.querySelectorAll('.livedot').forEach((e) => e.remove());
    document.querySelectorAll('.slot')[staleHour].insertAdjacentHTML('beforeend', '<span class="livedot"></span>');

    document.dispatchEvent(new Event('visibilitychange'));
    const picked = { dot: dotAt(), on: onAt() };
    userPickedSlot = false;
    document.dispatchEvent(new Event('visibilitychange'));
    return { hour: d.getHours(), staleHour, picked, auto: { dot: dotAt(), on: onAt() } };
  });
  check(`on unlock the live dot jumps to the current hour, got ${JSON.stringify(res)}`,
    res.picked.dot === res.hour);
  check('...without yanking a player off a slot they tapped themselves', res.picked.on === res.staleHour);
  check('...and an untouched map follows the clock to the live slot', res.auto.on === res.hour && res.auto.dot === res.hour);
}

{
  // app.js' freshness check: a long absence reloads the page on return, a
  // short glance away does not.
  await go('court.html');
  await page.evaluate(() => { window.__marker = 1; _hiddenAt = Date.now() - 5 * 60 * 1000; });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await new Promise((r) => setTimeout(r, 300));
  check('a 5-minute absence keeps the page as it was', (await page.evaluate(() => window.__marker)) === 1);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.evaluate(() => { _hiddenAt = Date.now() - 2 * 60 * 60 * 1000; document.dispatchEvent(new Event('visibilitychange')); }),
  ]);
  check('a 2-hour absence reloads the page fresh', (await page.evaluate(() => window.__marker)) === undefined);
}

{
  // The court map is venue-wide, so it must work with no saved team at
  // all -- unlike every other tab, it needs no program in context.
  await page.evaluate(() => localStorage.removeItem('thirdcoast-my-team'));
  await go('court.html');
  await new Promise((r) => setTimeout(r, 400));
  check('court.html works with no saved team', (await page.$$('.court-card')).length === 12);
  check('...and marks nobody\'s court as mine', (await page.$$('.court-card.mine')).length === 0);
  check('...and its Court tab is the active one',
    await page.$eval('.tab[data-tab="court"]', (el) => el.classList.contains('on')));
  check('...while Home stays a live link out of it',
    await page.$eval('.tab[data-tab="home"]', (el) => !el.classList.contains('on') && !el.classList.contains('off')));
}

// ---- season rollover: index.html -> season.html --------------------------
//
// The bug these cover, seen live on 2026-09-19: a player's saved pointer is
// {programId, teamId}, scoped to ONE season's program. When that season
// ended, NOTHING noticed -- the archiver keeps rewriting standings for
// completed programs, so gamenight.html's stale-pointer branch (which needs
// no standings row AND no archived game) could never fire, and the player
// sat on "No game scheduled right now" permanently while their real new
// season played out under a different program id.
//
// Fixture 9100 is that exact shape: a completed program that still has a
// full standings file and real archived games, and no schedule file at all.

// (h) The regression itself. Before the fix this landed on gamenight.html
// and rendered last season's record forever.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9100, teamId: 901, teamName: '1. Old Name Squad', programName: 'Test Rollover League' }),
));
await goHome();
check(
  `a saved team whose season has ENDED routes to season.html, not a permanently empty game night, got ${path()}`,
  path() === '/season.html',
);
{
  const rendered = await page.$eval('#body', (el) => el.innerText);
  check('season.html names the league that ended', rendered.includes('Test Rollover League'));
  // The whole point of voting the old roster into their current teams:
  // 901 -> 951 is a RENAME, so no team-name comparison could have found it.
  check(`season.html guesses the renamed successor team from the old roster's players, got ${JSON.stringify(rendered)}`,
    rendered.includes('Totally Different Name'));
  check('season.html poses the guess as a question rather than switching silently',
    (await page.$eval('.cta', (el) => el.textContent.trim())) === "That's me");
  // Until the player confirms, the pointer must not move -- a wrong guess
  // written silently is invisible to them.
  const stillOld = JSON.parse(await page.evaluate(() => localStorage.getItem('thirdcoast-my-team')));
  check('season.html leaves the saved pointer alone until the player confirms',
    stillOld.programId === 9100 && stillOld.teamId === 901);
  check('season.html is not a dead end -- its Home tab is a live link',
    await page.$eval('.tab[data-tab="home"]', (el) => !el.classList.contains('on') && !el.classList.contains('off')));
}

// ...and confirming actually rolls the pointer forward, into a screen that
// shows the NEW season's next game. This is the end-to-end fix.
{
  const visited = [];
  const record = (frame) => { if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname); };
  page.on('framenavigated', record);
  await clickThrough('.cta');
  await settleRouter();
  page.off('framenavigated', record);
  const now = JSON.parse(await page.evaluate(() => localStorage.getItem('thirdcoast-my-team')));
  check(`"That's me" moves the saved pointer to the new season's program and team, got ${JSON.stringify(now)}`,
    now.programId === 9101 && now.teamId === 951 && now.programName === 'Test Rollover League');
  check(`...and goes back through the router, which lands on the new season's game night, got ${path()}`,
    visited.includes('/index.html') && path() === '/gamenight.html?program=9101&team=951');
  check('...and that game night really renders the new season match card', (await page.$$('.mgame')).length === 1);
}

// ...and a player who comes back again is NOT asked twice: their pointer
// now names a live program, so the router leaves them alone.
await goHome();
check(`a rolled-over player goes straight to their game night on the next visit, got ${path()}`,
  path() === '/gamenight.html?program=9101&team=951');

// (i) Ambiguous: only one of a two-person team came back. One vote out of
// two is not a majority, so the app must NOT guess -- it offers the new
// season's teams instead. (This is the shape roughly a third of real teams
// arrive in: half of a 2s pair returning with a new partner.)
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9100, teamId: 902, teamName: '2. Split Pair', programName: 'Test Rollover League' }),
));
await goHome();
check(`an ambiguous rollover still routes to season.html, got ${path()}`, path() === '/season.html');
{
  const rendered = await page.$eval('#body', (el) => el.innerText);
  check('season.html does not offer a guess it cannot stand behind', !(await page.$('.cta')));
  check('season.html says plainly that it could not tell', rendered.includes("couldn't tell"));
  const opts = await page.$$eval('#opts .result b', (els) => els.map((el) => el.textContent.trim()));
  check(`season.html offers every team in the new season of the same league, got ${JSON.stringify(opts)}`,
    JSON.stringify(opts) === JSON.stringify(['Totally Different Name', 'New Partners']));
  await clickThrough('#opts .result:nth-child(2)');
  await settleRouter();
  const now = JSON.parse(await page.evaluate(() => localStorage.getItem('thirdcoast-my-team')));
  check(`picking a team from the list rolls the pointer forward, got ${JSON.stringify(now)}`,
    now.programId === 9101 && now.teamId === 952);
}

// (j) The new season is announced but has no teams posted yet -- a real,
// weeks-long state (every new Tuesday/Monday program on 2026-09-19). It is
// the reason this resolves against programs-index.json and not
// active-teams-index.json, which cannot see such a program at all.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9200, teamId: 961, teamName: '1. Patient FC', programName: 'Test Waiting League' }),
));
await goHome();
check(`a season whose successor has no teams yet still routes to season.html, got ${path()}`, path() === '/season.html');
{
  const rendered = await page.$eval('#body', (el) => el.innerText);
  check('season.html tells the player the next season exists and is on the calendar',
    rendered.includes('Test Waiting League') && rendered.includes('On the calendar'));
  check('season.html promises to pick their team up once it is posted', rendered.includes('automatically'));
  check('season.html still offers a way out to search',
    await page.$eval('a.textlink', (el) => el.getAttribute('href') === 'search.html'));
}

// (k) Season over and no league of that name is running at all.
await page.evaluate(() => localStorage.setItem(
  'thirdcoast-my-team',
  JSON.stringify({ programId: 9300, teamId: 971, teamName: '1. Last Of Their Kind', programName: 'Test Defunct League' }),
));
await goHome();
check(`a season with no successor league routes to season.html, got ${path()}`, path() === '/season.html');
{
  const rendered = await page.$eval('#body', (el) => el.innerText);
  check('season.html is honest when there is no new season on the calendar',
    rendered.includes('no new season') && !(await page.$('.cta')));
  check('season.html still offers search as the way forward',
    await page.$eval('a.textlink', (el) => el.getAttribute('href') === 'search.html'));
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
// The destination moved to season.html with the rollover fix, and the
// reason is worth stating: "your pointer names a program that is not
// running" is ONE condition, whether that program finished last month or
// never existed. Splitting it across two screens by how much archived data
// happens to be left behind is what produced the original bug -- the
// recovery lived on the branch that a finished season could never reach.
// Every guarantee this block has always made is asserted below unchanged;
// only the screen that makes them changed.
check('a dead program with no schedule file still routes somewhere real, not a stuck router',
  path() === '/season.html');
// Rendered text, not page.content(): the raw HTML includes the page's own
// inline <script> source, so a plain string.includes() against it can pass
// purely because the source code MENTIONS these words, whether or not the
// branch that renders them into #body ever actually ran.
{
  const renderedStale = await page.$eval('#body', (el) => el.innerText);
  check('a stale saved team is told plainly that its league is not running',
    renderedStale.includes('Dead League') && renderedStale.includes('no new season'));
  check(
    'the stale-team screen offers the way out, not a "check back after the next archive run" dead end',
    !renderedStale.includes('check back after the next archive run'),
  );
  check('a pointer with nothing to roll forward to gets no guess and no confirm button',
    !(await page.$('.cta')));
}
check(
  'the stale pointer is cleared on the spot, so the player is never re-asked every time they open the app',
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

// ---- team history: promoted / moved-down badges -------------------------
await go('rankings.html?program=9001');
{
  const badges = await page.$$eval('.rank-row', (rows) => rows.map((r) => ({
    name: r.querySelector('.nm b').textContent.trim(),
    mv: r.querySelector('.mv')?.className ?? null,
    text: r.querySelector('.mv')?.textContent.trim() ?? null,
  })));
  const testers = badges.find((b) => b.name.includes('Testers United'));
  const fixture = badges.find((b) => b.name.includes('Fixture FC'));
  const prophets = badges.find((b) => b.name.includes('Net Prophets'));
  check(`rankings marks a promoted team, got ${JSON.stringify(testers)}`,
    testers?.mv === 'mv up' && testers.text === '▲ Up from B');
  check(`rankings marks a team that came down, naming the other night, got ${JSON.stringify(fixture)}`,
    fixture?.mv === 'mv down' && fixture.text === '▼ Down from Mon AA');
  check('rankings leaves a team with no prior season unbadged', prophets?.mv === null);
}

await go('team.html?program=9001&team=501');
{
  const sub = await page.$eval('.team-hero .sub', (el) => el.textContent);
  check(`team header shows the season count and the promotion, got "${sub}"`,
    sub.includes('2nd season') && sub.includes('Up from B'));
  const hist = await page.$$eval('.hist-row', (rows) => rows.map((r) => ({
    res: r.querySelector('.res').firstChild.textContent.trim(),
    here: r.classList.contains('here'),
    href: r.closest('a')?.getAttribute('href'),
  })));
  check(`team history lists every season newest first, got ${JSON.stringify(hist)}`,
    hist.length === 2 && hist[0].here && hist[0].res === '8-1-1' && hist[1].res === '9-1-0'
      && hist[1].href === 'team.html?team=401&program=9000');
  const oppBadge = await page.$$eval('.opp-row', (rows) => rows
    .filter((r) => r.querySelector('.nm .nmt').textContent.includes('Fixture FC'))
    .map((r) => r.querySelector('.mv')?.textContent.trim()));
  check(`team page Opponents rows carry the move badge too, got ${JSON.stringify(oppBadge)}`,
    oppBadge[0] === '▼ Down from Mon AA');
}
await go('team.html?program=9001&team=506');
{
  const hasHistory = await page.$('.hist-row');
  check('a first-season team shows no history card', hasHistory === null);
}

await go('player.html?person=1');
{
  const hist = await page.$$eval('.hist-row', (rows) => rows.map((r) => r.innerText));
  check(`player card lists each season with its league and record, got ${JSON.stringify(hist)}`,
    hist.length === 1 && hist[0].includes('Test Tuesday League') && hist[0].includes('8-1-1')
      && /up from b/i.test(hist[0]) && /captain/i.test(hist[0]));
}

// ---- omnisearch -----------------------------------------------------------
await go('search.html');
check('search.html (the save-your-team search) gets no omnisearch button', (await page.$('.omni-btn')) === null);

await go('rankings.html?program=9001');
{
  const inTopbar = await page.$('.topbar .omni-btn');
  check('every top bar carries the omnisearch button', inTopbar !== null);
  await page.click('.omni-btn');
  await page.waitForSelector('.omni input');
  const focused = await page.evaluate(() => document.activeElement?.matches('.omni input'));
  check('opening omnisearch focuses its input', focused === true);

  await page.type('.omni input', 'sam', { delay: 20 });
  await page.waitForSelector('.omni-row');
  const people = await page.$$eval('.omni-row b', (els) => els.map((e) => e.firstChild.textContent.trim()));
  check(`omnisearch ranks name-starts-with first, newest first, then substrings, got ${JSON.stringify(people)}`,
    JSON.stringify(people) === JSON.stringify(['Sam', 'Samira', 'Isam']));

  await page.$eval('.omni input', (el) => { el.value = ''; });
  await page.type('.omni input', 'testers', { delay: 20 });
  const teams = await page.$$eval('.omni-row', (els) => els.map((e) => ({
    href: e.getAttribute('href'), text: e.innerText,
  })));
  check(`omnisearch folds a team's seasons into one row pointing at its newest, got ${JSON.stringify(teams)}`,
    teams.length === 1 && teams[0].href === 'team.html?team=501&program=9001' && teams[0].text.includes('2 seasons'));

  await page.$eval('.omni input', (el) => { el.value = ''; });
  await page.type('.omni input', 'sam net', { delay: 20 });
  const narrowed = await page.$$eval('.omni-row b', (els) => els.map((e) => e.firstChild.textContent.trim()));
  check(`a second word narrows by team name, got ${JSON.stringify(narrowed)}`,
    JSON.stringify(narrowed) === JSON.stringify(['Isam']));

  await page.keyboard.press('Escape');
  check('Escape closes omnisearch', (await page.$('.omni')) === null);

  await page.click('.omni-btn');
  await page.waitForSelector('.omni input');
  await page.type('.omni input', 'robin', { delay: 20 });
  await page.waitForSelector('.omni-row');
  await clickThrough('.omni-row');
  check('an omnisearch player result opens their card', path() === '/player.html?person=2');
}

// ---- install guide: phone browser vs installed app ------------------------
// Real detection, not the test hook: a spoofed iPhone Safari with
// navigator.webdriver hidden, once as a plain browser tab and once as a
// home-screen app (navigator.standalone).
{
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
  const phone = async ({ standalone }) => {
    const p = await browser.newPage();
    p.on('pageerror', (err) => { pageErrors++; console.error('PAGE ERROR:', err.message); });
    await p.setUserAgent(IPHONE);
    await p.evaluateOnNewDocument((sa) => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'standalone', { get: () => sa });
    }, standalone);
    return p;
  };

  const tab = await phone({ standalone: false });
  await tab.goto(`${BASE}/court.html`, { waitUntil: 'networkidle0' });
  await tab.evaluate(() => localStorage.clear());
  await tab.reload({ waitUntil: 'networkidle0' });
  const shown = await tab.evaluate(() => ({
    platform: document.querySelector('.install-nag')?.dataset.platform ?? null,
    steps: [...document.querySelectorAll('.nag-steps li')].map((li) => li.textContent),
    arrow: document.querySelector('.nag-arrow')?.className ?? null,
    demo: !!document.querySelector('.nag-demo'),
    caps: [...document.querySelectorAll('.nd-frame')].map((f) => f.dataset.cap),
  }));
  check(`Safari 26's walkthrough shows every tap: •••, Share, Add to Home Screen, Add, got ${JSON.stringify(shown.caps)}`,
    JSON.stringify(shown.caps.slice(0, 4)) === JSON.stringify(['Tap •••', 'Tap Share', 'Tap Add to Home Screen', 'Tap Add']));
  check(`iPhone Safari in a browser tab gets the full-screen guide, got ${JSON.stringify(shown.platform)}`,
    shown.platform === 'ios-safari' && shown.demo);
  check(`Safari 26's guide says to tap ••• first and points at it, got ${JSON.stringify(shown)}`,
    shown.steps[0].includes('bottom-right') && shown.arrow === 'nag-arrow bottom-right');

  await tab.click('.nag-later');
  check('"Not now" dismisses the guide', (await tab.$('.install-nag')) === null);
  await tab.goto(`${BASE}/rankings.html?program=9001`, { waitUntil: 'networkidle0' });
  check('...and it stays away for the rest of the visit', (await tab.$('.install-nag')) === null);
  await tab.evaluate((k) => localStorage.setItem(k, String(Date.now() - 31 * 60 * 1000)), 'thirdcoast-install-nag-dismissed');
  await tab.reload({ waitUntil: 'networkidle0' });
  check('...but comes back on the next visit', (await tab.$('.install-nag')) !== null);
  await tab.close();

  // Older Safari has Share right in the toolbar: no ••• step.
  const old = await phone({ standalone: false });
  await old.setUserAgent(IPHONE.replace('Version/26.0', 'Version/18.6'));
  await old.goto(`${BASE}/court.html`, { waitUntil: 'networkidle0' });
  await old.evaluate(() => localStorage.clear());
  await old.reload({ waitUntil: 'networkidle0' });
  const oldCaps = await old.$$eval('.nd-frame', (fs) => fs.map((f) => f.dataset.cap));
  check(`pre-26 Safari's walkthrough starts at Share, got ${JSON.stringify(oldCaps)}`,
    oldCaps[0] === 'Tap Share' && !oldCaps.includes('Tap •••'));
  await old.close();

  const app = await phone({ standalone: true });
  await app.goto(`${BASE}/court.html`, { waitUntil: 'networkidle0' });
  await app.evaluate(() => localStorage.clear());
  await app.reload({ waitUntil: 'networkidle0' });
  check('the installed home-screen app never shows the guide', (await app.$('.install-nag')) === null);
  await app.close();

  // Android without Chrome's install offer: no dead Install button.
  const droid = await browser.newPage();
  await droid.evaluateOnNewDocument(() => { window.__installNag = 'android'; });
  await droid.goto(`${BASE}/court.html`, { waitUntil: 'networkidle0' });
  await droid.evaluate(() => localStorage.clear());
  await droid.reload({ waitUntil: 'networkidle0' });
  // Headless Chrome may genuinely offer an install (the manifest qualifies),
  // so start from a known "no offer" state rather than assuming one.
  const btnHidden = await droid.evaluate(() => {
    _installPrompt = null;
    document.querySelector('.install-nag').classList.remove('can-install');
    return getComputedStyle(document.querySelector('.nag-install')).display === 'none';
  });
  check('Android hides the Install button until Chrome actually offers one', btnHidden);
  await droid.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); });
  const btnShown = await droid.$eval('.nag-install', (b) => getComputedStyle(b).display !== 'none');
  check('...and shows it the moment Chrome does', btnShown);
  await droid.close();
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
