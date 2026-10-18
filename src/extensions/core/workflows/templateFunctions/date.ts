/**
 * Date and time template functions. The clock is injectable via
 * {@link setClock} so tests can fix "now".
 */

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

/**
 * Return the current time as an ISO 8601 string.
 *
 * Deterministic-testable: honors an injected clock via {@link setClock} so
 * tests can fix "now". Defaults to `Date.now()`.
 *
 * @returns The current time in ISO 8601 format
 */
export function nowIso(): string {
  return new Date(currentClock()).toISOString();
}
