# Before go-live

Known gaps found while debugging, deliberately deferred. Ordered by how
likely a real player is to hit one. Nothing here is a regression — these
are pre-existing or newly-discovered, not caused by recent work.

---

## 1. The floating tab bar — diagnosed, fix identified, NOT applied

**Status:** root cause found 2026-09-20 from a real device screenshot
(iPhone 14/15 Pro class, 1179×2556 @3x, installed PWA). Measured, not
theorised:

| | |
|---|---|
| viewport | 852 pt |
| `.screen` bottom edge | **793 pt** — 59 pt short |
| gap below the tab bar | **59.0 pt** of `--app-bg` (`#101A2C`) |
| tab bar height | 91 pt = `10 + 28 + 4 + 14 + 1 + 34` |

That 91 pt proves `env(safe-area-inset-bottom)` (34 pt) **is** being
applied correctly, so safe-area insets are not broken. And 59 pt is
exactly `safe-area-inset-top` on this device. The viewport height used
for bottom-anchoring is short by precisely the top inset.

**Cause:** `<meta name="apple-mobile-web-app-status-bar-style"
content="black-translucent">`. iOS paints the web view from y=0 (under
the status bar) but computes the containing block as though the status
bar were still reserved. Every bottom-anchored technique resolves against
that same wrong number — which is why three separate fixes
(`padding`, `100dvh`, `position:fixed`) each landed with zero visible
change. They were all on the wrong axis.

**Fix:** change that meta to `content="black"` (or drop it) on all nine
pages that carry it (every `.html` in `docs/`, `index.html` included —
verified). iOS then reserves the status bar properly and the viewport matches
the screen. Knock-on: `env(safe-area-inset-top)` becomes 0, so
`.topbar`'s `padding-top:max(14px, env(safe-area-inset-top))` resolves to
its original 14 px — still correct, since the OS now owns that strip.

**Verify with:** the `?debug=1` readout, or five taps on the topbar in the
installed app. Confirms if `innerHeight` reads **793** rather than 852.

**Also remove at the same time:** the debug overlay itself
(`wireDebugOverlay` / `debugReadout` / `showDebugOverlay` in
`docs/assets/app.js`, plus the `DEBUG_TAPS_NEEDED` constants). It is
explicitly temporary and must not ship long-term.

---

## 2. `playoffs.html` is a deliberate stub

There is no live playoff-bracket pipeline. The page says so honestly and
points at the venue's TV board.

**Who hits it today:** all four Monday leagues are in playoffs right now
(regular seasons finished, `PLAYOFFS` markers dated 2026-09-21), so every
Monday player currently lands here instead of on real content.

Not a bug — documented as intentional — but it is the one place a real,
active league is materially under-served.

---

## 3. A new player cannot find a team in a just-announced league

`search.html` reads only `active-teams-index.json`, which is built from
parsed standings rows. A league that LeagueApps has announced but not yet
populated is therefore unsearchable, and a brand-new player gets "Not
found yet — check back after the archiver's next run" with no route in.

`season.html` covers the **returning** player in this window (it resolves
against `programs-index.json`, which does not depend on standings, and
shows a "next season is on the calendar" state). There is no equivalent
for someone who has never saved a team.

**Live right now:** the three new Monday programs (5154231 / 5154233 /
5154234) are `UPCOMING` with 0 searchable teams.

**Scope this honestly before building anything.** The obvious idea —
derive a fallback team list from `schedule/{programId}.json`'s
`games[].teams[]` — would **not** help in the case observed today: those
three programs have 0 games as well as 0 standings, so there is nothing
to derive from. In every rollover watched so far (5143219 on 2026-09-17,
5148510 on 2026-09-20) schedule and standings landed in the *same*
archive run, so a schedule-without-standings window has not actually been
observed, only assumed. Confirm it happens before writing code for it;
otherwise the real answer is just "wait for LeagueApps", which
`search.html` already says.

---

## 4. Archive freshness is bounded, not live

Cadence is every 3 hours (raised from 12 on 2026-09-20 after a real
nine-hour gap where the site told Tuesday players their season was not
posted). GitHub also delays scheduled runs — observed consistently ~3 h
late on this repo — so the practical worst case is still several hours.

No timestamp is written into `docs/data/` on purpose: a wall-clock field
made every file differ on every run and defeated the workflow's
`git diff --quiet` commit gate. If "last updated" ever needs to be shown,
read it from the HTTP `Last-Modified` header rather than reintroducing a
field.

---

## 5. Cross-season rollover is a confirmed guess, by design

`season.html` asks rather than switching silently. Replayed over the 66
real teams that rolled over on 2026-09-19: 33 confident, 20 ambiguous, 13
genuinely did not return. The ambiguous third is not a solvable matching
problem — half of a 2s pair returning with a new partner is a real-world
ambiguity — so the confirm step should stay.

Worth a second look after one more season turns over, to check the
majority threshold in `isConfidentSuccessor` still behaves.
