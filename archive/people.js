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

export function mergePersonRecord(existing, appearance) {
  const { userId, firstName, programId, teamId, teamName, isCaptain } = appearance;
  const base = existing ?? { userId, firstName, appearances: [] };
  const alreadySeen = base.appearances.some(
    (a) => a.programId === programId && a.teamId === teamId,
  );
  const appearances = alreadySeen
    ? base.appearances
    : [...base.appearances, { programId, teamId, teamName, isCaptain }];
  return { userId, firstName, appearances };
}
