// archive/people.js
//
// The one place full names are allowed to exist, and only in memory, for
// exactly one call: firstNameOf() takes the first whitespace-delimited
// token and discards the rest. Nothing downstream of this module ever
// sees a full name again. See the design refinement at the top of this
// plan for why userId (not a name hash) is the person key.

export function firstNameOf(fullName) {
  return fullName.trim().split(/\s+/)[0];
}

// The surname, reduced to the single initial that archive/leagueapps.js's
// redaction pass already treats as the safe form ("Smith" -> "S."), and
// which is already public in every team name's "(Sarah F.)" captain
// suffix. A full surname must never reach disk -- see the header above and
// the Captain-name redaction block in leagueapps.js.
//
// Returns '' for a one-token name: LeagueApps really does carry those, and
// "Cher ." is worse than "Cher".
export function lastInitialOf(fullName) {
  const words = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return '';
  return `${words[words.length - 1][0].toUpperCase()}.`;
}

export function mergePersonRecord(existing, appearance) {
  const { userId, firstName, lastInitial, programId, teamId, teamName, isCaptain } = appearance;
  const base = existing ?? { userId, firstName, lastInitial, appearances: [] };
  const alreadySeen = base.appearances.some(
    (a) => a.programId === programId && a.teamId === teamId,
  );
  const appearances = alreadySeen
    ? base.appearances
    : [...base.appearances, { programId, teamId, teamName, isCaptain }];
  // lastInitial is a late addition: a record written before it existed has
  // none, so a fresh appearance is allowed to fill it in, but never to
  // blank out one already stored.
  return { userId, firstName, lastInitial: lastInitial || base.lastInitial || '', appearances };
}
