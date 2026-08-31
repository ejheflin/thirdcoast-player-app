// archive/schedule.js
//
// Turns a raw LeagueApps Activity into a real upcoming-game record for the
// "next game" home screen. Only `state === 'scheduled'` counts — verified
// live that `rescheduled` entries carry a stale original date, not the
// real new one, so they're excluded rather than trusted. Tournament
// markers (type: event_tournament) have no real teams and are excluded
// too. `todayISO` (a "YYYY-MM-DD" string) is passed in rather than
// computed internally so this stays testable without mocking the clock.

import { redactCaptainName, decodeEntities } from './leagueapps.js';

export function extractUpcomingGame(activity, todayISO, courtNameFn) {
  if (activity.state !== 'scheduled') return null;
  if (activity.type !== 'game_season') return null;
  const date = activity.start?.date;
  if (!date || date < todayISO) return null;
  if (!Array.isArray(activity.teams) || activity.teams.length === 0) return null;
  return {
    activityId: activity.id,
    date,
    time: activity.start?.time ?? null,
    courtName: courtNameFn(activity.subLocationId),
    // Decode BEFORE redacting -- same reason as activities.js: the JSON
    // API's teamName can arrive entity-encoded, and redactCaptainName
    // assumes clean text.
    teams: activity.teams.map((t) => ({
      teamId: t.teamId,
      teamName: redactCaptainName(decodeEntities(t.teamName)),
    })),
  };
}
