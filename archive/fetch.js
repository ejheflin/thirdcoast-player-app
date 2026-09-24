// archive/fetch.js
//
// Orchestrates one archive run. Every real I/O call (network fetches,
// disk reads/writes) is a parameter, never a direct import call inside
// runArchive — that's what makes this testable with zero mocking
// frameworks and zero real network/disk access in tests.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as leagueapps from './leagueapps.js';
import { firstNameOf, mergePersonRecord } from './people.js';
import { extractGame, appendGames } from './activities.js';
import { extractUpcomingGame, extractTournamentMarker } from './schedule.js';
import { buildLineage } from './lineage.js';

async function realReadJSON(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function realWriteJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// A small delay between per-program requests -- good-citizen pacing
// against LeagueApps' servers, not a hard technical requirement.
const REQUEST_DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How many rosters of FINISHED seasons one run may fetch. A finished
// season's roster never changes, so each is fetched exactly once and read
// back from docs/data/rosters/ on every later run -- but the first pass
// over the whole back catalog is ~4,000 pages, far too many for one
// scheduled run. The budget spreads that one-time backfill over a handful
// of runs; once it is done a run spends none of it at all.
const HISTORY_ROSTER_BUDGET = 600;

export async function runArchive(deps) {
  const {
    fetchPrograms, fetchActivities, fetchStandingsHTML, fetchRosterHTML, fetchLocations,
    parseStandings = leagueapps.parseStandings,
    parseRoster = leagueapps.parseRoster,
    readJSON, writeJSON,
    historyRosterBudget = HISTORY_ROSTER_BUDGET,
  } = deps;
  let historyBudget = historyRosterBudget;

  const programs = await fetchPrograms();
  const activePrograms = programs.filter((p) => p.state === 'LIVE' || p.state === 'UPCOMING');

  // Venue-wide data, identical for every program every run -- fetched once
  // per archive run rather than once per program.
  const locations = await fetchLocations();
  const courtName = (subLocationId) => leagueapps.courtName(locations, subLocationId);

  // The "which season is on right now" signal, and the ONLY one that does
  // not depend on standings being posted. active-teams-index.json below is
  // built out of parsed standings rows, so a brand-new UPCOMING program is
  // invisible in it until LeagueApps posts that program's first standings
  // table -- a real, weeks-long window (verified live on 2026-09-19: the
  // entire new Tuesday and Monday seasons were LIVE/UPCOMING with zero
  // standings rows). Without this file the site has no way to know a saved
  // team's program has ended, so a returning player stays pinned to a dead
  // season forever. Written first, and unconditionally, because every
  // rollover decision the site makes starts here.
  await writeJSON('docs/data/programs-index.json', activePrograms.map((p) => ({
    programId: p.id,
    programName: p.name,
    // LIVE vs UPCOMING is the difference between "games are being played"
    // and "the season is announced but hasn't started" -- the site says
    // different things in each case, so it needs the distinction, not just
    // membership in this list.
    state: p.state,
    // Explicitly null rather than absent when LeagueApps omits it, same
    // rule as `tournaments: []`: one shape per file, so no consumer has to
    // know that "missing" and "unknown" mean the same thing.
    endDate: p.endDate ?? null,
  })));

  const activeTeamsIndex = [];
  // Every standings table and every roster this run knows about, active or
  // not -- the team-history pass after the loop needs all of them at once.
  const standingsByProgram = new Map();
  const rostersByTeam = new Map();

  // Fetches one team's roster and writes the two files that come out of
  // it: the team -> people index, and each person's own record. Returns
  // the roster exactly as written, first names only.
  async function archiveRoster(program, row) {
    const rosterHtml = await fetchRosterHTML(program.id, row.teamId);
    await sleep(REQUEST_DELAY_MS);
    const players = parseRoster(rosterHtml);

    // The team -> people index. Without it nothing in the site can reach
    // a player card at all: people/{userId}.json can only be looked up
    // once you already know the userId, and no other file maps a team to
    // its players. First names only, exactly like people/*.json -- this
    // stores nothing people/*.json doesn't already hold.
    const roster = players.map((p) => ({
      userId: p.userId,
      firstName: firstNameOf(p.fullName),
      isCaptain: p.isCaptain,
    }));
    await writeJSON(`docs/data/rosters/${program.id}-${row.teamId}.json`, {
      programId: program.id,
      teamId: row.teamId,
      teamName: row.teamName,
      players: roster,
    });

    for (const player of players) {
      const path = `docs/data/people/${player.userId}.json`;
      const existing = await readJSON(path);
      const record = mergePersonRecord(existing, {
        userId: player.userId,
        firstName: firstNameOf(player.fullName),
        programId: program.id,
        teamId: row.teamId,
        teamName: row.teamName,
        isCaptain: player.isCaptain,
      });
      await writeJSON(path, record);
    }
    return roster;
  }

  for (const program of programs) {
    const html = await fetchStandingsHTML(program.id);
    await sleep(REQUEST_DELAY_MS);
    const rows = parseStandings(html, program.id);
    // No timestamp field here, deliberately: a fresh `new Date()` on every
    // run made every one of the ~416 standings files differ from disk even
    // when the league's actual data hadn't moved, so `git diff --quiet`
    // was always dirty and the workflow committed all of them twice a day
    // forever -- exactly what the spec's "commits only if data changed"
    // rule exists to prevent. Nothing in the site ever read it; git's own
    // commit history is the record of when data last actually changed.
    await writeJSON(`docs/data/standings/${program.id}.json`, {
      programId: program.id,
      programName: program.name,
      rows,
    });

    standingsByProgram.set(program.id, rows);

    const isActive = activePrograms.some((p) => p.id === program.id);
    if (!isActive) {
      // A finished season: its rosters are history, so one already on disk
      // is final and is read back instead of fetched again.
      for (const row of rows) {
        if (!row.teamId) continue;
        const key = `${program.id}|${row.teamId}`;
        const cached = await readJSON(`docs/data/rosters/${program.id}-${row.teamId}.json`);
        if (cached) {
          rostersByTeam.set(key, cached.players ?? []);
        } else if (historyBudget > 0) {
          historyBudget -= 1;
          rostersByTeam.set(key, await archiveRoster(program, row));
        }
      }
      continue;
    }

    for (const row of rows) {
      activeTeamsIndex.push({
        programId: program.id,
        programName: program.name,
        teamId: row.teamId,
        teamName: row.teamName,
      });
      rostersByTeam.set(`${program.id}|${row.teamId}`, await archiveRoster(program, row));
    }
  }

  if (activePrograms.length > 0) {
    const activities = await fetchActivities(activePrograms.map((p) => p.id));
    const byProgram = new Map();
    for (const activity of activities) {
      const game = extractGame(activity);
      if (!game) continue;
      if (!byProgram.has(activity.programId)) byProgram.set(activity.programId, []);
      byProgram.get(activity.programId).push(game);
    }
    for (const program of activePrograms) {
      const path = `docs/data/activities/${program.id}.json`;
      const existing = await readJSON(path);
      const merged = appendGames(existing?.games ?? [], byProgram.get(program.id) ?? []);
      await writeJSON(path, { programId: program.id, games: merged });
    }

    // Same already-fetched `activities` array, reused rather than fetched
    // again -- upcoming games for the "next game" home screen, and the
    // program-wide playoff markers the site's router needs to tell a
    // playoff night from a regular one. One pass, two collectors: the
    // markers live in the SAME schedule file as the games because they
    // are the same thing (this program's upcoming calendar), and the
    // router reads both together to decide which is next.
    const todayISO = new Date().toISOString().slice(0, 10);
    const upcomingByProgram = new Map();
    const tournamentsByProgram = new Map();
    const pushTo = (map, programId, value) => {
      if (!map.has(programId)) map.set(programId, []);
      map.get(programId).push(value);
    };
    for (const activity of activities) {
      const game = extractUpcomingGame(activity, todayISO, courtName);
      if (game) pushTo(upcomingByProgram, activity.programId, game);
      const tournament = extractTournamentMarker(activity, todayISO);
      if (tournament) pushTo(tournamentsByProgram, activity.programId, tournament);
    }
    const byDateThenTime = (a, b) => {
      const dateCmp = a.date.localeCompare(b.date);
      if (dateCmp !== 0) return dateCmp;
      return (a.time ?? '').localeCompare(b.time ?? '');
    };
    for (const program of activePrograms) {
      const games = (upcomingByProgram.get(program.id) ?? []).sort(byDateThenTime);
      const tournaments = (tournamentsByProgram.get(program.id) ?? []).sort(byDateThenTime);
      await writeJSON(`docs/data/schedule/${program.id}.json`, {
        programId: program.id,
        games,
        tournaments,
      });
    }

    // The venue-wide court map, re-indexing those same games by NIGHT and
    // SLOT instead of by program.
    //
    // It has to be built here rather than in the browser because the axis
    // is wrong everywhere else: schedules are stored per program, but a
    // real Tuesday night is five programs sharing one floor of 12 courts.
    // Drawing that client-side would mean fetching every active program's
    // schedule (16 files on 2026-09-20) to render a single screen. Here
    // the games are already in memory, so the merge is free.
    //
    // One file per night rather than one big file: a night is ~8-12KB and
    // is all the court screen ever needs at once, while the whole horizon
    // (21 nights on 2026-09-20) would be a quarter of a megabyte fetched
    // to show one evening.
    const courtsByDate = new Map();
    for (const program of activePrograms) {
      for (const game of upcomingByProgram.get(program.id) ?? []) {
        const court = leagueapps.courtNumberOf(game.courtName);
        // A map entry needs both a court to sit on and a slot to sit in.
        // Either missing is a real, normal state -- a court is often
        // unassigned early in a season -- so the game is simply left out
        // of the map rather than given an invented placeholder. It still
        // appears in its own program's schedule file, which is what every
        // other screen reads.
        if (court === null || !game.time) continue;
        if (!courtsByDate.has(game.date)) courtsByDate.set(game.date, new Map());
        const slots = courtsByDate.get(game.date);
        if (!slots.has(game.time)) slots.set(game.time, []);
        slots.get(game.time).push({
          court,
          courtName: game.courtName,
          programId: program.id,
          programName: program.name,
          teams: game.teams,
        });
      }
    }
    for (const [date, slots] of courtsByDate) {
      await writeJSON(`docs/data/courts/${date}.json`, {
        date,
        slots: [...slots.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([time, courts]) => ({ time, courts: courts.sort((a, b) => a.court - b.court) })),
      });
    }
    // So the court screen can pick "tonight, else the next night" from one
    // small fetch instead of probing dates until one answers.
    await writeJSON('docs/data/courts/index.json', {
      dates: [...courtsByDate.keys()].sort(),
    });
  }

  await writeJSON('docs/data/active-teams-index.json', activeTeamsIndex);

  // Team history: which team last season each team is, and whether it
  // came up or down a level to get here. Built here, over every roster in
  // the catalog, because no page could afford to: answering it in the
  // browser would mean fetching thousands of roster files.
  const catalog = programs.map((p) => ({ id: p.id, name: p.name, endDate: p.endDate ?? null }));
  const lineage = buildLineage({ programs: catalog, standings: standingsByProgram, rosters: rostersByTeam });
  for (const [programId, teams] of lineage) {
    if (Object.keys(teams).length === 0) continue;
    await writeJSON(`docs/data/lineage/${programId}.json`, { programId, teams });
  }

  await writeJSON('docs/data/search-index.json', buildSearchIndex(programs, standingsByProgram, rostersByTeam, lineage));
}

// The omnisearch's whole world in one file, fetched once, the first time
// someone opens the search. Rows are arrays rather than objects and
// programs are referenced by index, because the file carries every team
// and every player in the back catalog and object keys would be most of
// its weight. First names only, like every other file in docs/data.
//
//   programs: [programId, programName, endDate, state]   newest first
//   teams:    [programIndex, teamId, teamName, seasons]
//   people:   [userId, firstName, programIndex, teamId, teamName, seasons]
//             -- the program and team are the person's LATEST, which is
//                what tells one "Sam" from another in a result list.
export function buildSearchIndex(programs, standingsByProgram, rostersByTeam, lineage) {
  const ordered = [...programs].sort((a, b) => (b.endDate ?? 0) - (a.endDate ?? 0) || b.id - a.id);
  const indexOf = new Map(ordered.map((p, i) => [p.id, i]));

  const teams = [];
  for (const p of ordered) {
    for (const r of standingsByProgram.get(p.id) ?? []) {
      if (!r.teamId) continue;
      teams.push([indexOf.get(p.id), r.teamId, r.teamName, lineage.get(p.id)?.[r.teamId]?.seasons ?? 1]);
    }
  }

  const people = new Map();
  for (const [key, players] of rostersByTeam) {
    const [programId, teamId] = key.split('|').map(Number);
    const at = indexOf.get(programId);
    if (at === undefined) continue;
    const teamName = (standingsByProgram.get(programId) ?? []).find((r) => r.teamId === teamId)?.teamName ?? '';
    for (const pl of players) {
      const seen = people.get(pl.userId);
      if (!seen) {
        people.set(pl.userId, { firstName: pl.firstName, at, teamId, teamName, seasons: 1 });
        continue;
      }
      seen.seasons += 1;
      // Lower index = newer program: keep the latest team as the label.
      if (at < seen.at) Object.assign(seen, { at, teamId, teamName });
    }
  }

  return {
    programs: ordered.map((p) => [p.id, p.name, p.endDate ?? null, p.state]),
    teams,
    people: [...people.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([userId, p]) => [userId, p.firstName, p.at, p.teamId, p.teamName, p.seasons]),
  };
}

// Node 20.11+ hands us the module's own path directly, already in the same
// platform-native form as argv[1]. The previous file:// URL construction
// never actually matched on Windows (wrong slash count after the scheme)
// and only worked through an endsWith() fallback.
if (import.meta.filename === process.argv[1]) {
  const deps = {
    fetchPrograms: leagueapps.fetchPrograms,
    fetchActivities: leagueapps.fetchActivities,
    fetchStandingsHTML: leagueapps.fetchStandingsHTML,
    fetchRosterHTML: leagueapps.fetchRosterHTML,
    fetchLocations: leagueapps.fetchLocations,
    parseStandings: leagueapps.parseStandings,
    parseRoster: leagueapps.parseRoster,
    readJSON: realReadJSON,
    writeJSON: realWriteJSON,
    // A by-hand backfill can lift the per-run cap: ARCHIVE_HISTORY_BUDGET=5000.
    ...(process.env.ARCHIVE_HISTORY_BUDGET
      ? { historyRosterBudget: Number(process.env.ARCHIVE_HISTORY_BUDGET) }
      : {}),
  };
  runArchive(deps)
    .then(() => console.log('archive run complete'))
    .catch((err) => {
      console.error('archive run FAILED:', err);
      process.exitCode = 1;
    });
}
