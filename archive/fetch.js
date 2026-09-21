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

export async function runArchive(deps) {
  const {
    fetchPrograms, fetchActivities, fetchStandingsHTML, fetchRosterHTML, fetchLocations,
    parseStandings = leagueapps.parseStandings,
    parseRoster = leagueapps.parseRoster,
    readJSON, writeJSON,
  } = deps;

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

    const isActive = activePrograms.some((p) => p.id === program.id);
    if (!isActive) continue;

    for (const row of rows) {
      activeTeamsIndex.push({
        programId: program.id,
        programName: program.name,
        teamId: row.teamId,
        teamName: row.teamName,
      });

      const rosterHtml = await fetchRosterHTML(program.id, row.teamId);
      await sleep(REQUEST_DELAY_MS);
      const players = parseRoster(rosterHtml);

      // The team -> people index. Without it nothing in the site can reach
      // a player card at all: people/{userId}.json can only be looked up
      // once you already know the userId, and no other file maps a team to
      // its players. First names only, exactly like people/*.json -- this
      // stores nothing people/*.json doesn't already hold.
      await writeJSON(`docs/data/rosters/${program.id}-${row.teamId}.json`, {
        programId: program.id,
        teamId: row.teamId,
        teamName: row.teamName,
        players: players.map((p) => ({
          userId: p.userId,
          firstName: firstNameOf(p.fullName),
          isCaptain: p.isCaptain,
        })),
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
  };
  runArchive(deps)
    .then(() => console.log('archive run complete'))
    .catch((err) => {
      console.error('archive run FAILED:', err);
      process.exitCode = 1;
    });
}
