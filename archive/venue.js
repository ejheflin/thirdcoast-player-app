// archive/venue.js
//
// The building, and what "today" means inside it. These facts are
// deliberately here rather than in the data: nothing in docs/data records
// a timezone or an address, because every program this site has ever
// archived is played in one place.
//
// They live in their own module because two very different consumers need
// them -- ics.js, to turn a wall-clock game time into an absolute instant,
// and fetch.js, to decide which games are still upcoming. Putting the
// timezone in either one would have left the other importing across a
// layer it has no other business with.

export const VENUE_TZ = 'America/Chicago';
export const VENUE_ADDRESS = 'Third Coast Volleyball, 5652 Forney Dr, Houston, TX 77036';

// The venue's own calendar date, as a "YYYY-MM-DD" string.
//
// NOT new Date().toISOString().slice(0, 10). That is the UTC date, and the
// archiver runs on GitHub Actions, whose clock is UTC: between 19:00
// Central (18:00 in winter) and local midnight, the UTC date is already
// tomorrow. The cron fires at 00:00 UTC, i.e. 19:00 Central -- squarely
// inside that window, with the evening's 19:30/20:30/21:30 games still to
// be played. Those games were being dated into the past and dropped from
// docs/data/schedule/, so the home screen rotated to next week's game a
// few minutes before a player's own match started.
//
// Intl is the only thing in Node that knows the DST rules; reading them
// back out of formatted parts is the standard way to get at them without
// shipping a timezone database. formatToParts rather than a formatted
// string so this does not depend on a locale's field order, and 'en-US'
// so the calendar is Gregorian whatever the runner's locale is.
export function venueTodayISO(now = new Date(), timeZone = VENUE_TZ) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)) {
    parts[part.type] = part.value;
  }
  // Zero-padded, because the whole site compares these as strings:
  // "2026-9-7" sorts below "2026-10-07" and would break every date gate it
  // touches. '2-digit' already pads month and day; the year is padded for
  // the same reason and costs nothing.
  return `${String(parts.year).padStart(4, '0')}-${parts.month}-${parts.day}`;
}
