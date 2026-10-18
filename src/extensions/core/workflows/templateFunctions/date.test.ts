import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { evaluateExpression } from "../templateEval";
import { setClock, setDefaultTimeZone } from "./date";

/** Evaluates an expression against the given scope and returns its value. */
function ev(expr: string, scope: Record<string, unknown> = {}): unknown {
  const result = evaluateExpression(expr, scope);
  if (!result.ok) throw new Error(result.warning);
  return result.value;
}

describe("date functions (Europe/Berlin, fixed clock)", () => {
  beforeEach(() => {
    setDefaultTimeZone("Europe/Berlin");
    // 2026-10-18T22:30:00Z = 2026-10-19 00:30 in Berlin (CEST, +02:00)
    setClock(() => Date.parse("2026-10-18T22:30:00Z"));
  });
  afterEach(() => {
    setDefaultTimeZone(null);
    setClock(null);
  });

  test("today uses the workflow zone, not UTC", () => {
    expect(ev("today()")).toBe("2026-10-19");
    expect(ev('today("UTC")')).toBe("2026-10-18");
    expect(ev('today("Not/AZone")')).toBe("");
  });

  test("formatDate formats in the zone with German names by default", () => {
    expect(ev('formatDate(nowIso(), "dd.MM.yyyy HH:mm")')).toBe("19.10.2026 00:30");
    expect(ev('formatDate(nowIso(), "HH:mm", "UTC")')).toBe("22:30");
    expect(ev('formatDate("2026-10-18", "EEEE, d. MMMM yyyy")')).toBe("Sonntag, 18. Oktober 2026");
    expect(ev('formatDate("2026-10-18", "EEEE", "", "en")')).toBe("Sunday");
    expect(ev('formatDate(0, "yyyy", "UTC")')).toBe("1970");
  });

  test("formatDate yields an empty string for unusable input or patterns", () => {
    expect(ev('formatDate("not a date", "yyyy")')).toBe("");
    expect(ev('formatDate(missing, "yyyy")')).toBe("");
    expect(ev('formatDate("2026-10-18", "YYYY")')).toBe("");
  });

  test("a plain date is midnight in the zone", () => {
    expect(ev('startOfDay("2026-10-18")')).toBe("2026-10-18T00:00:00.000+02:00");
    expect(ev('timestamp("2026-10-18")')).toBe(Date.parse("2026-10-17T22:00:00Z"));
  });

  test("parseDate reads a pattern as local time", () => {
    expect(ev('parseDate("18.10.2026 08:30", "dd.MM.yyyy HH:mm")')).toBe("2026-10-18T08:30:00.000+02:00");
    expect(ev('parseDate("18.12.2026", "dd.MM.yyyy")')).toBe("2026-12-18T00:00:00.000+01:00");
    expect(ev('parseDate("18.10.2026", "dd.MM.yyyy", "UTC")')).toBe("2026-10-18T00:00:00.000+00:00");
    expect(ev('parseDate("garbage", "dd.MM.yyyy")')).toBe("");
  });

  test("addDays keeps the wall-clock time across the DST change", () => {
    // Berlin switches from CEST to CET on 2026-10-25.
    expect(ev('addDays("2026-10-24T12:00", 1)')).toBe("2026-10-25T12:00:00.000+01:00");
    expect(ev('addHours("2026-10-25T01:00", 2)')).toBe("2026-10-25T02:00:00.000+01:00");
    expect(ev('addMinutes("2026-10-18T10:00", -30)')).toBe("2026-10-18T09:30:00.000+02:00");
    expect(ev('addMonths("2026-01-31", 1)')).toBe("2026-02-28T00:00:00.000+01:00");
    expect(ev('addDays("nope", 1)')).toBe("");
  });

  test("diff functions count from the first to the second date", () => {
    expect(ev('diffDays("2026-10-18T23:00", "2026-10-19T01:00")')).toBe(1);
    expect(ev('diffDays(today(), "2026-10-24")')).toBe(5);
    expect(ev('diffDays("2026-10-24", "2026-10-18")')).toBe(-6);
    expect(ev('diffHours("2026-10-18T08:00", "2026-10-18T10:59")')).toBe(2);
    expect(ev('diffMinutes("2026-10-18T08:00", "2026-10-18T08:45")')).toBe(45);
    expect(ev('diffDays("x", "2026-10-18")')).toBeNaN();
  });

  test("startOfDay, endOfDay, weekday", () => {
    expect(ev("startOfDay(nowIso())")).toBe("2026-10-19T00:00:00.000+02:00");
    expect(ev('endOfDay("2026-10-18")')).toBe("2026-10-18T23:59:59.999+02:00");
    expect(ev('weekday("2026-10-18")')).toBe(7);
    expect(ev("weekday(nowIso())")).toBe(1);
    expect(ev('weekday(nowIso(), "UTC")')).toBe(7);
  });

  test("results feed back into other date functions", () => {
    expect(ev('formatDate(addDays(today(), 7), "dd.MM.yyyy")')).toBe("26.10.2026");
  });
});

describe("setDefaultTimeZone", () => {
  test("rejects unknown zones", () => {
    expect(() => setDefaultTimeZone("Mars/Base")).toThrow("Invalid time zone");
  });
});
