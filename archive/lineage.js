// archive/lineage.js
//
// Team history across seasons: which team in an earlier season THIS team
// is, and whether it moved up or down a level to get here.
//
// LeagueApps has no notion of a team outliving its season -- every season
// is a brand-new program with brand-new team ids -- so the link has to be
// inferred. It is inferred from people, not names, for the same reason
// season.html's rollover does it that way: team names are captain-typed
// and routinely change between seasons ("Blake's Beaches" -> "Crab"),
// while the players on the team are the team.
//
// Pure functions only: fetch.js hands in everything already in memory.

const DAY = 24 * 60 * 60 * 1000;

// The level ladder, top to bottom. BB sits ABOVE B -- LeagueApps' own
// renames say so: "Tuesday Coed 4s BB (formerly Intermediate #1)" and
// "Tuesday Coed 4s B (formerly Intermediate #2)", and on Monday "BB (Upper
// Intermediate)" next to "B (Intermediate)".
const LEVEL_RANK = { AA: 5, A: 4, BB: 3, B: 2, 'Upper Rec': 1 };
const LEVEL_ALIASES = { 'Upper Recreational': 'Upper Rec' };

// The pre-2023 names, before the venue switched to letter grades. The
// same old word meant different things on different nights ("Upper
// Intermediate" became A on Tuesday 4s but BB on Monday 2s), so these are
// mapped per league, each one taken from a real "(formerly ...)" rename in
// the program catalog. An old name with no recorded rename is left out
// (null level) rather than guessed at.
const OLD_NAMES = {
  'Tuesday Coed 4s Upper Intermediate': 'A',
  'Tuesday Coed 4s Intermediate #1': 'BB',
  'Tuesday Coed 4s Intermediate #2': 'B',
  'Thursday Coed 2s Competitive': 'AA',
  'Thursday Coed 2s Upper Intermediate': 'A',
  'Thursday Coed 4s Intermediate': 'B',
  'Monday Coed 2s Upper Intermediate': 'BB',
  'Monday Coed 2s Intermediate': 'B',
  'Monday Coed 3s Intermediate': 'B',
  'Friday Coed 2s Intermediate': 'B',
};

// Short-run side events, not seasons of a ladder: a pop-up runs alongside
// the regular Monday leagues, and KOB/QOB/snake drafts are individual
// formats. None of them is "the season before" anything, and a team
// moving between one and a real league has not been promoted.
const NOT_A_LADDER = /pop ?up|kob|qob|snake|football/i;

const LEAGUE_RE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(Coed|Mens|Womens)\s+(\d)s\s+(.+)$/i;

// "Tuesday Coed 4s BB" -> { day, format: 'Coed 4s', level: 'BB', rank: 3 }.
// Null for anything that is not a rung on a ladder.
export function parseLeague(programName) {
  const raw = String(programName ?? '').trim();
  if (!raw || NOT_A_LADDER.test(raw)) return null;
  // "Thursday Coed 2s AA (formerly Comp)" -- the letter before the
  // parenthetical is the real level; the note after it is history.
  const name = raw.replace(/\s*\([^)]*\)\s*$/, '');
  const m = LEAGUE_RE.exec(name);
  if (!m) return null;
  const [, day, gender, size, rest] = m;
  const levelText = OLD_NAMES[name] ?? LEVEL_ALIASES[rest] ?? rest;
  // "B/BB" is a real combined league; it sits between its two rungs.
  const parts = levelText.split('/').map((s) => LEVEL_ALIASES[s.trim()] ?? s.trim());
  if (parts.some((p) => !(p in LEVEL_RANK))) return null;
  const rank = parts.reduce((sum, p) => sum + LEVEL_RANK[p], 0) / parts.length;
  return {
    day: day[0].toUpperCase() + day.slice(1).toLowerCase(),
    format: `${gender[0].toUpperCase()}${gender.slice(1).toLowerCase()} ${size}s`,
    level: parts.join('/'),
    rank,
  };
}

// A team name with the league's seed prefix and the captain parenthetical
// taken off, for the one thing names are still good for here: breaking a
// tie when only part of a roster came back.
function nameKey(teamName) {
  return String(teamName ?? '')
    .replace(/^\s*\d+\s*[.\-–)]\s*/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// A predecessor has to have ended well before this season did (so a
// league running on another night of the SAME season is never mistaken
// for last season), but not so long before that it is ancient history.
// Seasons run ~10-13 weeks; the window allows one season off.
const MIN_GAP = 45 * DAY;
const MAX_GAP = 240 * DAY;

// programs:  [{ id, name, endDate }]
// standings: Map programId -> rows (as parseStandings returns them)
// rosters:   Map `${programId}|${teamId}` -> [{ userId, ... }]
//
// Returns Map programId -> { [teamId]: entry }, one entry per team that
// has a standings row, where entry is
//   { seasons, move, from, history }
//   seasons  -- how many seasons this team has played, this one included
//   move     -- 'up' | 'down' | 'same' | null (null: no comparable prior season)
//   from     -- { programId, teamId, programName, teamName, level } | null
//   history  -- every season, oldest first, this one last
export function buildLineage({ programs, standings, rosters }) {
  const programById = new Map(programs.map((p) => [p.id, { ...p, league: parseLeague(p.name) }]));

  // Every team a person has been on, from the rosters alone.
  const teamsOf = new Map();
  for (const [key, players] of rosters) {
    const [programId, teamId] = key.split('|').map(Number);
    for (const p of players ?? []) {
      if (!teamsOf.has(p.userId)) teamsOf.set(p.userId, []);
      teamsOf.get(p.userId).push({ programId, teamId });
    }
  }

  const rowOf = new Map();
  for (const [programId, rows] of standings) {
    for (const r of rows) rowOf.set(`${programId}|${r.teamId}`, { ...r, teamCount: rows.length });
  }

  function predecessorOf(programId, teamId) {
    const program = programById.get(programId);
    if (!program?.endDate) return null;
    const players = rosters.get(`${programId}|${teamId}`) ?? [];
    if (players.length === 0) return null;
    const myName = nameKey(rowOf.get(`${programId}|${teamId}`)?.teamName);

    const tally = new Map();
    for (const p of players) {
      const seen = new Set();
      for (const t of teamsOf.get(p.userId) ?? []) {
        const prior = programById.get(t.programId);
        if (!prior?.endDate || !prior.league) continue;
        const gap = program.endDate - prior.endDate;
        if (gap < MIN_GAP || gap > MAX_GAP) continue;
        const key = `${t.programId}|${t.teamId}`;
        if (seen.has(key)) continue; // one vote per person per team
        seen.add(key);
        const entry = tally.get(key) ?? { ...t, prior, votes: 0 };
        entry.votes += 1;
        tally.set(key, entry);
      }
    }

    const mine = program.league;
    const sameDay = (c) => (mine && c.prior.league.day === mine.day && c.prior.league.format === mine.format ? 1 : 0);
    const sameFormat = (c) => (mine && c.prior.league.format === mine.format ? 1 : 0);
    // A candidate counts when a strict majority of this roster played on
    // it -- or the captain kept the team name and at least one player came
    // along. Among those, the MOST RECENT wins, not the biggest overlap:
    // a real Tuesday team had 4 players in common with its July roster and
    // 3 with September's, and picking July skipped a season outright.
    const qualifies = (c) => c.votes * 2 > players.length
      || (myName && nameKey(rowOf.get(`${c.programId}|${c.teamId}`)?.teamName) === myName);
    const [best] = [...tally.values()].filter(qualifies).sort((a, b) =>
      sameDay(b) - sameDay(a) || sameFormat(b) - sameFormat(a)
      || b.prior.endDate - a.prior.endDate || b.votes - a.votes);
    return best ?? null;
  }

  // Only a move within one format means anything: Coed 4s B to Coed 2s A
  // is a different team shape, not a promotion.
  function moveBetween(from, to) {
    if (!from || !to || from.format !== to.format) return null;
    return from.rank < to.rank ? 'up' : from.rank > to.rank ? 'down' : 'same';
  }

  const memo = new Map();
  function historyOf(programId, teamId) {
    const key = `${programId}|${teamId}`;
    if (memo.has(key)) return memo.get(key);
    const program = programById.get(programId);
    const row = rowOf.get(key);
    // endDate strictly decreases along the chain, so this recursion always
    // terminates -- no cycle guard needed.
    const pred = predecessorOf(programId, teamId);
    const earlier = pred ? historyOf(pred.programId, pred.teamId) : [];
    const season = {
      programId,
      teamId,
      programName: program?.name ?? null,
      teamName: row?.teamName ?? null,
      endDate: program?.endDate ?? null,
      level: program?.league?.level ?? null,
      // How this season was reached from the one before it in the list.
      move: pred ? moveBetween(pred.prior.league, program?.league) : null,
      position: row?.position ?? null,
      teamCount: row?.teamCount ?? null,
      wins: row?.wins ?? 0,
      losses: row?.losses ?? 0,
      ties: row?.ties ?? 0,
    };
    const history = [...earlier, season];
    memo.set(key, history);
    return history;
  }

  const out = new Map();
  for (const [programId, rows] of standings) {
    const teams = {};
    for (const r of rows) {
      if (!r.teamId) continue;
      const history = historyOf(programId, r.teamId);
      const here = history[history.length - 1];
      const prev = history.length > 1 ? history[history.length - 2] : null;
      teams[r.teamId] = {
        seasons: history.length,
        move: here.move,
        from: prev ? {
          programId: prev.programId,
          teamId: prev.teamId,
          programName: prev.programName,
          teamName: prev.teamName,
          level: prev.level,
        } : null,
        history,
      };
    }
    out.set(programId, teams);
  }
  return out;
}
