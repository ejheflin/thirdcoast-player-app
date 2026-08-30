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
    fetchPrograms, fetchActivities, fetchStandingsHTML, fetchRosterHTML,
    parseStandings = leagueapps.parseStandings,
    parseRoster = leagueapps.parseRoster,
    readJSON, writeJSON,
  } = deps;

  const programs = await fetchPrograms();
  const activePrograms = programs.filter((p) => p.state === 'LIVE' || p.state === 'UPCOMING');

  const activeTeamsIndex = [];

  for (const program of programs) {
    const html = await fetchStandingsHTML(program.id);
    await sleep(REQUEST_DELAY_MS);
    const rows = parseStandings(html, program.id);
    await writeJSON(`data/standings/${program.id}.json`, {
      programId: program.id,
      programName: program.name,
      updatedAt: new Date().toISOString(),
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
      for (const player of players) {
        const path = `data/people/${player.userId}.json`;
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
      const path = `data/activities/${program.id}.json`;
      const existing = await readJSON(path);
      const merged = appendGames(existing?.games ?? [], byProgram.get(program.id) ?? []);
      await writeJSON(path, { programId: program.id, games: merged });
    }
  }

  await writeJSON('data/active-teams-index.json', activeTeamsIndex);
}

const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMain || process.argv[1]?.endsWith('fetch.js')) {
  const deps = {
    fetchPrograms: leagueapps.fetchPrograms,
    fetchActivities: leagueapps.fetchActivities,
    fetchStandingsHTML: leagueapps.fetchStandingsHTML,
    fetchRosterHTML: leagueapps.fetchRosterHTML,
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
