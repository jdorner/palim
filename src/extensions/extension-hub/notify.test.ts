import { describe, expect, test } from "bun:test";
import type { UpdateSummary } from "./hub";
import { missingWorkflowWarning, newUpdates, notificationPayload, updateKey } from "./notify";

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
  test("returns only updates whose extension and commit are not known", () => {
    const known = new Set([updateKey(summary("foo", "c1")), updateKey(summary("bar", "c2"))]);
    const current = [summary("foo", "c1"), summary("bar", "c3"), summary("baz", "c4")];
    expect(newUpdates(known, current).map((u) => u.name)).toEqual(["bar", "baz"]);
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
  });
});

describe("missingWorkflowWarning", () => {
  test("warns about a workflow that does not exist", () => {
    expect(missingWorkflowWarning("gone", ["a", "b"])).toContain('"gone" does not exist');
  });

  test("does not warn about an existing workflow or an empty name", () => {
    expect(missingWorkflowWarning("a", ["a", "b"])).toBeNull();
    expect(missingWorkflowWarning("", [])).toBeNull();
  });
});
