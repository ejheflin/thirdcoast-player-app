// archive/schedule.js
//
// Turns a raw LeagueApps Activity into a real upcoming-game record for the
// "next game" home screen. Only `state === 'scheduled'` counts — verified
// live that `rescheduled` entries carry a stale original date, not the
// real new one, so they're excluded rather than trusted. Tournament
// markers (type: event_tournament) have no real teams, so
// extractUpcomingGame still excludes them — extractTournamentMarker
// below is what captures them instead. `todayISO` (a "YYYY-MM-DD"
// string) is passed in rather than computed internally so this stays
// testable without mocking the clock.

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

// The program-wide playoff marker. LeagueApps' real ones (verified live
// against all 17 currently-active programs: 13 markers, every one of
// them state 'scheduled') look like this:
//
//   { type: 'event_tournament', state: 'scheduled', title: 'PLAYOFFS',
//     start: { date: '2026-09-02', time: '18:30' }, teams: [], ... }
//
// Two shape facts drive the return value:
//
//   * `teams` is ALWAYS empty on these. The marker applies to the whole
//     program, not to a specific matchup, so there is no teams field
//     here at all -- a caller must not try to filter these by team.
//   * `title` is the literal string "PLAYOFFS" in every real one, i.e.
//     an event label, never a person's name, so unlike a team name it
//     needs no redactCaptainName pass. It IS decoded, though: it comes
//     from the same JSON API whose text can arrive entity-encoded, and
//     the site escapes it again on render, so an undecoded "&#39;" would
//     be shown to a player verbatim.
//
// Same state/type/date gating as extractUpcomingGame, for the same
// reasons, and the same injected `todayISO`.
export function extractTournamentMarker(activity, todayISO) {
  if (activity.state !== 'scheduled') return null;
  if (activity.type !== 'event_tournament') return null;
  const date = activity.start?.date;
  if (!date || date < todayISO) return null;
  return {
    activityId: activity.id,
    date,
    time: activity.start?.time ?? null,
    // Guarded rather than passed straight to decodeEntities, which throws
    // on null by design (see leagueapps.js): an untitled event is a real,
    // survivable shape here, not the malformed-team-name bug that guard
    // exists to surface.
    title: activity.title == null ? null : decodeEntities(activity.title),
  };
}
