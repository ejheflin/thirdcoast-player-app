// Turns a raw LeagueApps Activity into the durable per-game record this
// project keeps forever, since LeagueApps' own feed empties out once the
// season completes. Only activities with a real recorded result count —
// a scheduled-but-unplayed activity has no result/score at all.

import { redactCaptainName } from './leagueapps.js';

export function extractGame(activity) {
  if (activity.state !== 'played_regular_time') return null;
  if (!Array.isArray(activity.teams) || activity.teams.length === 0) return null;
  return {
    activityId: activity.id,
    date: activity.start?.date ?? null,
    teams: activity.teams.map((t) => ({
      teamId: t.teamId,
      teamName: redactCaptainName(t.teamName),
      result: t.result,
      score: t.score,
    })),
  };
}

export function appendGames(existingGames, newGames) {
  const byId = new Map(existingGames.map((g) => [g.activityId, g]));
  for (const g of newGames) {
    if (g) byId.set(g.activityId, g);
  }
  return [...byId.values()].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}
