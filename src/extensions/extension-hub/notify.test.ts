import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { UpdateSummary } from "./hub";
import { newUpdates, notificationPayload, UpdateNotificationPayloadSchema, updateKey } from "./notify";

/** Builds an update summary for tests. */
function summary(name: string, commit: string, version: string | null = "1.1.0"): UpdateSummary {
  return {
    name,
    source: "Main",
    installedVersion: "1.0.0",
    ref: `${name}@1.0.0`,
    update: { ref: `${name}@${version ?? "x"}`, commit, version },
  };
}

describe("newUpdates", () => {
  test("returns only updates whose extension, ref, and commit are not known", () => {
    const known = new Set([updateKey(summary("foo", "c1")), updateKey(summary("bar", "c2"))]);
    const current = [summary("foo", "c1"), summary("bar", "c3"), summary("baz", "c4")];
    expect(newUpdates(known, current).map((u) => u.name)).toEqual(["bar", "baz"]);
  });

  test("counts a new release tag on an already known commit as new", () => {
    const known = new Set([updateKey(summary("foo", "c1", "1.2.0"))]);
    expect(newUpdates(known, [summary("foo", "c1", "1.3.0")]).map((u) => u.update.ref)).toEqual(["foo@1.3.0"]);
  });

  test("counts a moved branch head as new", () => {
    const branch = (commit: string): UpdateSummary => ({
      ...summary("foo", commit, null),
      ref: "main",
      update: { ref: "main", commit, version: null },
    });
    expect(newUpdates(new Set([updateKey(branch("c1"))]), [branch("c2")])).toHaveLength(1);
  });

  test("returns nothing when all updates are known", () => {
    const current = [summary("foo", "c1")];
    expect(newUpdates(new Set(current.map(updateKey)), current)).toEqual([]);
  });
});

describe("notificationPayload", () => {
  test("flattens the updates, sorts them by name, and adds time and hub URL", () => {
    const payload = notificationPayload(
      [summary("foo", "c1"), summary("bar", "c2", null)],
      new Date("2026-11-23T10:00:00Z"),
      "http://palim.local/ext-page/extension-hub/hub",
    );
    expect(payload).toEqual({
      updates: [
        {
          name: "bar",
          source: "Main",
          installedVersion: "1.0.0",
          installedRef: "bar@1.0.0",
          latestRef: "bar@x",
          latestVersion: null,
          commit: "c2",
        },
        {
          name: "foo",
          source: "Main",
          installedVersion: "1.0.0",
          installedRef: "foo@1.0.0",
          latestRef: "foo@1.1.0",
          latestVersion: "1.1.0",
          commit: "c1",
        },
      ],
      checkedAt: "2026-11-23T10:00:00.000Z",
      hubUrl: "http://palim.local/ext-page/extension-hub/hub",
    });
    expect(Value.Check(UpdateNotificationPayloadSchema, payload)).toBe(true);
  });
});
