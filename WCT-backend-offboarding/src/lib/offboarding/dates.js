'use strict';

// Calendar-date helpers. Every offboarding date rule (notice period, "last
// day not in the past", reminder windows) is judged in Malaysia time, not
// the server's UTC clock, so an App Service in any region behaves the same.

const TZ = 'Asia/Kuala_Lumpur';

/** Today's date in Malaysia as 'YYYY-MM-DD'. Tests may pin it. */
function todayMYT() {
  if (process.env.NODE_ENV === 'test' && process.env.OFFBOARDING_TODAY_OVERRIDE) {
    return process.env.OFFBOARDING_TODAY_OVERRIDE;
  }
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const toUtc = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

function addDays(iso, n) {
  return new Date(toUtc(iso) + n * 86400000).toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (negative if `toIso` is earlier). */
function daysBetween(fromIso, toIso) {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / 86400000);
}

const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(toUtc(v));

function yearMYT() { return todayMYT().slice(0, 4); }

module.exports = { todayMYT, addDays, daysBetween, isIsoDate, yearMYT, TZ };
