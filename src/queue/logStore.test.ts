/**
 * Unit tests for the LogStore persistent job log layer.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "@src/db";
import { LogStore } from "./logStore";

describe("LogStore", () => {
  let store: LogStore;

  beforeEach(() => {
    // Ensure DB is initialized (migrations run on first call)
    getDb();
    store = new LogStore();
  });

  describe("getLastTimestamp", () => {
    test("returns undefined when no logs exist for a job", () => {
      const result = store.getLastTimestamp("nonexistent-job-id");
      expect(result).toBeUndefined();
    });

    test("returns the timestamp of the last log entry by sequence", () => {
      const jobId = `test-last-ts-${Date.now()}`;

      store.append(jobId, 1, "first log", 1000);
      store.append(jobId, 2, "second log", 2000);
      store.append(jobId, 3, "third log", 3000);

      const result = store.getLastTimestamp(jobId);
      expect(result).toBe(3000);

      // Cleanup
      store.deleteLogs(jobId);
    });

    test("returns correct timestamp even when entries are inserted out of order", () => {
      const jobId = `test-last-ts-unordered-${Date.now()}`;

      // Insert seq 3 first, then 1, then 2
      store.append(jobId, 3, "third", 3000);
      store.append(jobId, 1, "first", 1000);
      store.append(jobId, 2, "second", 2000);

      // Should return the timestamp for seq=3 (the highest seq)
      const result = store.getLastTimestamp(jobId);
      expect(result).toBe(3000);

      // Cleanup
      store.deleteLogs(jobId);
    });

    test("returns the single entry timestamp when only one log exists", () => {
      const jobId = `test-last-ts-single-${Date.now()}`;

      store.append(jobId, 1, "only entry", 5555);

      const result = store.getLastTimestamp(jobId);
      expect(result).toBe(5555);

      // Cleanup
      store.deleteLogs(jobId);
    });
  });
});
