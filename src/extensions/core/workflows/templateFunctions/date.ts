/**
 * Date and time template functions, built on date-fns with time zone support
 * from `@date-fns/tz`.
 *
 * Inputs are ISO 8601 strings or epoch milliseconds. A string without an
 * offset - including a plain date like `2026-10-18` - is read as local time in
 * the effective time zone, never as UTC. Calendar operations (days, months,
 * start/end of day) run in that zone, so they respect daylight saving time.
 * Date results are ISO 8601 strings with the zone's offset
 * (`2026-10-18T00:00:00.000+02:00`); unusable input yields "" (or `NaN` for
 * numeric results).
 *
 * The effective zone is the optional `tz` argument, else the default set by
 * {@link setDefaultTimeZone} (from `WORKFLOW_TIMEZONE` at boot), else the
 * server's zone. The clock is injectable via {@link setClock} so tests can fix
 * "now".
 */

import { tz as inZone, TZDate } from "@date-fns/tz";
import {
  addDays as dfAddDays,
  addHours as dfAddHours,
  addMinutes as dfAddMinutes,
  addMonths as dfAddMonths,
  endOfDay as dfEndOfDay,
  startOfDay as dfStartOfDay,
  differenceInCalendarDays,
  differenceInHours,
  differenceInMinutes,
  format,
  getISODay,
  isValid,
  type Locale,
  parse,
  parseISO,
} from "date-fns";
import { de, enUS } from "date-fns/locale";
import { toInt, toStr } from "./coerce";

/** Injectable clock (milliseconds since epoch). Defaults to `Date.now`. */
let _clock: () => number = () => Date.now();

/**
 * Override the clock used by time functions. Intended for tests.
 *
 * @param clock - A function returning milliseconds since epoch, or null to reset
 */
export function setClock(clock: (() => number) | null): void {
  _clock = clock ?? (() => Date.now());
}

/**
 * Read the current clock value (milliseconds since epoch).
 *
 * @returns Milliseconds since epoch from the active clock
 */
export function currentClock(): number {
  return _clock();
}

/** The server's time zone. */
const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Time zone used when a function gets no `tz` argument. */
let _defaultTimeZone = SYSTEM_TIME_ZONE;

/** Cache of {@link isValidTimeZone} results. */
const zoneValidity = new Map<string, boolean>();

/**
 * Whether a string names a time zone the runtime knows (IANA name or `UTC`).
 *
 * @param zone - The time zone name
 * @returns True when it is usable
 */
export function isValidTimeZone(zone: string): boolean {
  if (zone === "") return false;
  let valid = zoneValidity.get(zone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      valid = true;
    } catch {
      valid = false;
    }
    // Bounded: zone names come from workflow data.
    if (zoneValidity.size < 1000) zoneValidity.set(zone, valid);
  }
  return valid;
}

/**
 * Set the default time zone of the date functions (from `WORKFLOW_TIMEZONE`).
 *
 * @param zone - An IANA time zone name, or null/"" for the server's zone
 * @throws Error when the zone is not a valid time zone
 */
export function setDefaultTimeZone(zone: string | null): void {
  if (!zone) {
    _defaultTimeZone = SYSTEM_TIME_ZONE;
    return;
  }
  if (!isValidTimeZone(zone)) throw new Error(`Invalid time zone: "${zone}"`);
  _defaultTimeZone = zone;
}

/**
 * The time zone a function call works in.
 *
 * @param zone - The optional `tz` argument
 * @returns The argument when given, else the default zone (validity is checked by the caller via the result)
 */
function zoneOf(zone: unknown): string {
  return zone === undefined || zone === null || zone === "" ? _defaultTimeZone : toStr(zone);
}

/**
 * Read a template value as a point in time in a zone.
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param zone - The time zone
 * @returns The date, or null when the value or the zone is unusable
 */
function toDate(value: unknown, zone: string): TZDate | null {
  if (!isValidTimeZone(zone)) return null;
  let date: TZDate;
  if (typeof value === "number") {
    date = new TZDate(value, zone);
  } else if (typeof value === "string" && value.trim() !== "") {
    // parseISO with a zone context reads offset-less strings (and plain dates)
    // as local time in that zone; `new TZDate(string)` would use the server's zone.
    date = parseISO(value.trim(), { in: inZone(zone) }) as TZDate;
  } else {
    return null;
  }
  return isValid(date) ? date : null;
}

/**
 * Serialize a date as ISO 8601 with its zone offset.
 *
 * @param date - The date, or null
 * @returns The ISO string, or "" for null
 */
function iso(date: TZDate | null): string {
  return date && isValid(date) ? date.toISOString() : "";
}

/** date-fns locales by language code; `formatDate` falls back to German. */
const LOCALES: Record<string, Locale> = { de, en: enUS };

/**
 * Pick a date-fns locale by language (`de`, `en`, `en-US`, ...).
 *
 * @param locale - The locale argument
 * @returns The matching locale, German when missing or unknown
 */
function localeOf(locale: unknown): Locale {
  const lang = toStr(locale).toLowerCase().split(/[-_]/)[0] ?? "";
  return LOCALES[lang] ?? de;
}

/**
 * Return the current time as an ISO 8601 string (UTC).
 *
 * Deterministic-testable: honors an injected clock via {@link setClock} so
 * tests can fix "now". Defaults to `Date.now()`.
 *
 * @returns The current time in ISO 8601 format
 */
export function nowIso(): string {
  return new Date(currentClock()).toISOString();
}

/**
 * Today's date in a time zone.
 *
 * @param zone - Optional time zone (default: workflow default)
 * @returns The date as `yyyy-MM-dd`, or "" for an invalid zone
 */
export function today(zone?: unknown): string {
  const date = toDate(currentClock(), zoneOf(zone));
  return date ? format(date, "yyyy-MM-dd") : "";
}

/**
 * Format a date with a date-fns pattern (`dd.MM.yyyy HH:mm`, `d. MMMM yyyy`, ...).
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param pattern - The date-fns format pattern
 * @param zone - Optional time zone (default: workflow default)
 * @param locale - Language for month and weekday names (`de` default, `en`)
 * @returns The formatted date, or "" for unusable input or an invalid pattern
 */
export function formatDate(value: unknown, pattern: unknown, zone?: unknown, locale?: unknown): string {
  const date = toDate(value, zoneOf(zone));
  if (!date) return "";
  try {
    return format(date, toStr(pattern), { locale: localeOf(locale) });
  } catch {
    return "";
  }
}

/**
 * Read a date written in a given pattern (`parseDate("18.10.2026", "dd.MM.yyyy")`).
 *
 * @param value - The date text
 * @param pattern - The date-fns pattern it is written in
 * @param zone - Optional time zone the text is local to (default: workflow default)
 * @returns The date as ISO 8601, or "" when the text does not match the pattern
 */
export function parseDate(value: unknown, pattern: unknown, zone?: unknown): string {
  const z = zoneOf(zone);
  if (!isValidTimeZone(z)) return "";
  try {
    const reference = new TZDate(currentClock(), z);
    return iso(parse(toStr(value), toStr(pattern), reference, { in: inZone(z) }) as TZDate);
  } catch {
    return "";
  }
}

/**
 * Apply a date-fns operation to a date in the default zone.
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param op - The operation
 * @returns The result as ISO 8601, or "" for unusable input
 */
function shift(value: unknown, op: (date: TZDate) => Date): string {
  const date = toDate(value, _defaultTimeZone);
  return date ? iso(op(date) as TZDate) : "";
}

/**
 * Add calendar days (keeps the wall-clock time across daylight saving changes).
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param days - Days to add (negative subtracts)
 * @returns The date as ISO 8601, or "" for unusable input
 */
export function addDays(value: unknown, days: unknown): string {
  return shift(value, (d) => dfAddDays(d, toInt(days, 0)));
}

/**
 * Add hours.
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param hours - Hours to add (negative subtracts)
 * @returns The date as ISO 8601, or "" for unusable input
 */
export function addHours(value: unknown, hours: unknown): string {
  return shift(value, (d) => dfAddHours(d, toInt(hours, 0)));
}

/**
 * Add minutes.
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param minutes - Minutes to add (negative subtracts)
 * @returns The date as ISO 8601, or "" for unusable input
 */
export function addMinutes(value: unknown, minutes: unknown): string {
  return shift(value, (d) => dfAddMinutes(d, toInt(minutes, 0)));
}

/**
 * Add calendar months (the day is clamped to the month's end: Jan 31 + 1 → Feb 28).
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param months - Months to add (negative subtracts)
 * @returns The date as ISO 8601, or "" for unusable input
 */
export function addMonths(value: unknown, months: unknown): string {
  return shift(value, (d) => dfAddMonths(d, toInt(months, 0)));
}

/**
 * Compare two dates in the default zone.
 *
 * @param from - Start date
 * @param to - End date
 * @param op - The date-fns difference (`to` first, as date-fns expects)
 * @returns The difference, or `NaN` for unusable input
 */
function diff(from: unknown, to: unknown, op: (later: TZDate, earlier: TZDate) => number): number {
  const a = toDate(from, _defaultTimeZone);
  const b = toDate(to, _defaultTimeZone);
  return a && b ? op(b, a) : Number.NaN;
}

/**
 * Calendar days from one date to another (positive when `to` is later),
 * counted in the default zone: from 23:00 to 01:00 the next day is 1 day.
 *
 * @param from - Start date
 * @param to - End date
 * @returns The number of calendar days, or `NaN` for unusable input
 */
export function diffDays(from: unknown, to: unknown): number {
  return diff(from, to, (b, a) => differenceInCalendarDays(b, a, { in: inZone(_defaultTimeZone) }));
}

/**
 * Full hours from one date to another (positive when `to` is later).
 *
 * @param from - Start date
 * @param to - End date
 * @returns The number of full hours, or `NaN` for unusable input
 */
export function diffHours(from: unknown, to: unknown): number {
  return diff(from, to, (b, a) => differenceInHours(b, a));
}

/**
 * Full minutes from one date to another (positive when `to` is later).
 *
 * @param from - Start date
 * @param to - End date
 * @returns The number of full minutes, or `NaN` for unusable input
 */
export function diffMinutes(from: unknown, to: unknown): number {
  return diff(from, to, (b, a) => differenceInMinutes(b, a));
}

/**
 * Midnight at the start of the date's day.
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param zone - Optional time zone (default: workflow default)
 * @returns The start of day as ISO 8601, or "" for unusable input
 */
export function startOfDay(value: unknown, zone?: unknown): string {
  const date = toDate(value, zoneOf(zone));
  return date ? iso(dfStartOfDay(date) as TZDate) : "";
}

/**
 * The last millisecond of the date's day.
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param zone - Optional time zone (default: workflow default)
 * @returns The end of day as ISO 8601, or "" for unusable input
 */
export function endOfDay(value: unknown, zone?: unknown): string {
  const date = toDate(value, zoneOf(zone));
  return date ? iso(dfEndOfDay(date) as TZDate) : "";
}

/**
 * Day of the week, ISO numbering.
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @param zone - Optional time zone (default: workflow default)
 * @returns 1 (Monday) to 7 (Sunday), or `NaN` for unusable input
 */
export function weekday(value: unknown, zone?: unknown): number {
  const date = toDate(value, zoneOf(zone));
  return date ? getISODay(date) : Number.NaN;
}

/**
 * Epoch milliseconds of a date.
 *
 * @param value - ISO 8601 string or epoch milliseconds
 * @returns Milliseconds since 1970-01-01T00:00:00Z, or `NaN` for unusable input
 */
export function timestamp(value: unknown): number {
  const date = toDate(value, _defaultTimeZone);
  return date ? date.getTime() : Number.NaN;
}
