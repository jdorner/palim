/**
 * Tests for the VariableStore.
 *
 * Uses an in-memory Bun SQLite database wrapped with Drizzle and the
 * global_variables schema created directly (matching the migration shape in
 * drizzle/0009_add-global-variables.sql). No mocking frameworks; property
 * tests use fast-check with a minimum of 100 runs.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fc from "fast-check";
import { VariableStore } from "./store";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

/**
 * Create a fresh in-memory Drizzle database with the global_variables table.
 *
 * The table shape mirrors drizzle/0009_add-global-variables.sql, including the
 * unique index on variable_key.
 *
 * @returns A VariableStore backed by a fresh in-memory SQLite database.
 */
function createTestStore(): VariableStore {
  return createTestStoreWithDb().store;
}

/**
 * Create a fresh in-memory SQLite database plus a VariableStore over it.
 *
 * Returns the underlying Bun SQLite Database so a second VariableStore can be
 * constructed over the same connection (used by the persistence example case).
 * The table shape mirrors drizzle/0009_add-global-variables.sql.
 *
 * @returns The raw SQLite database and a VariableStore backed by it.
 */
function createTestStoreWithDb(): { sqlite: Database; store: VariableStore } {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite);

  sqlite.run(`
    CREATE TABLE global_variables (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      variable_key text NOT NULL,
      value text NOT NULL,
      description text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `);
  sqlite.run("CREATE UNIQUE INDEX uq_global_variables_key ON global_variables (variable_key)");

  return { sqlite, store: new VariableStore(db) };
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

/**
 * Generate a valid variable key matching ^[A-Z][A-Z0-9_]{0,63}$.
 *
 * First character is an uppercase letter; the remaining 0 to 63 characters are
 * uppercase letters, digits, or underscores.
 */
const FIRST_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const REST_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split("");

const keyArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...FIRST_CHARS), fc.array(fc.constantFrom(...REST_CHARS), { minLength: 0, maxLength: 63 }))
  .map(([first, rest]) => first + rest.join(""));

/** Generate a non-empty value of 1 to 65536 characters. */
const valueArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 65536 });

/** Generate an optional description of up to 1024 characters (or undefined). */
const descriptionArb: fc.Arbitrary<string | undefined> = fc.option(fc.string({ minLength: 0, maxLength: 1024 }), {
  nil: undefined,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VariableStore", () => {
  // Feature: global-variables, Property 1
  describe("Property 1: upsert/get round-trip", () => {
    // Validates: Requirements 1.1, 1.2, 1.3, 8.1, 8.3, 10.1
    test("get returns the stored value and description byte-for-byte", () => {
      fc.assert(
        fc.property(keyArb, valueArb, descriptionArb, (key, value, description) => {
          const store = createTestStore();

          store.upsert(key, value, description);
          const entry = store.get(key);

          expect(entry).not.toBeUndefined();
          expect(entry!.key).toBe(key);
          expect(entry!.value).toBe(value);

          if (description === undefined || description === "") {
            // No description given (or empty): stored as null -> undefined on read.
            expect(entry!.description ?? "").toBe("");
          } else {
            expect(entry!.description).toBe(description);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: global-variables, Property 2
  describe("Property 2: upsert overwrites on existing key", () => {
    // Validates: Requirements 1.7, 2.1, 2.2, 2.3
    test("second upsert on the same key replaces value/description and leaves exactly one row", () => {
      fc.assert(
        fc.property(
          keyArb,
          valueArb,
          descriptionArb,
          valueArb,
          descriptionArb,
          (key, firstValue, firstDescription, secondValue, secondDescription) => {
            const store = createTestStore();

            store.upsert(key, firstValue, firstDescription);
            store.upsert(key, secondValue, secondDescription);

            // Exactly one row remains for this key after the overwrite.
            const rowsForKey = store.list().filter((entry) => entry.key === key);
            expect(rowsForKey.length).toBe(1);

            // The surviving row reflects the second pair, not the first.
            const entry = store.get(key);
            expect(entry).not.toBeUndefined();
            expect(entry!.key).toBe(key);
            expect(entry!.value).toBe(secondValue);

            if (secondDescription === undefined || secondDescription === "") {
              // Empty/undefined description stored as null -> undefined on read.
              expect(entry!.description ?? "").toBe("");
            } else {
              expect(entry!.description).toBe(secondDescription);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: global-variables, Property 3
  describe("Property 3: list reflects the store contents", () => {
    // Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 10.2
    test("list returns exactly one entry per distinct key with the last-written value/description", () => {
      fc.assert(
        fc.property(fc.array(fc.tuple(keyArb, valueArb, descriptionArb), { maxLength: 32 }), (variables) => {
          const store = createTestStore();

          // Compute the expected state: later upserts to the same key win.
          const expected = new Map<string, { value: string; description: string | undefined }>();
          for (const [key, value, description] of variables) {
            store.upsert(key, value, description);
            expected.set(key, { value, description });
          }

          const listed = store.list();

          // Exactly one entry per distinct key (no duplicates, no missing keys).
          expect(listed.length).toBe(expected.size);
          const listedKeys = new Set(listed.map((entry) => entry.key));
          expect(listedKeys.size).toBe(listed.length);
          for (const key of expected.keys()) {
            expect(listedKeys.has(key)).toBe(true);
          }

          // Each listed entry matches the last-written pair, values unmasked (req 10.2).
          for (const entry of listed) {
            const want = expected.get(entry.key);
            expect(want).not.toBeUndefined();
            expect(entry.value).toBe(want!.value);

            if (want!.description === undefined || want!.description === "") {
              // Empty/undefined description reads back as empty (req 4.5).
              expect(entry.description ?? "").toBe("");
            } else {
              // Non-empty description reads back exactly (req 4.4).
              expect(entry.description).toBe(want!.description);
            }
          }
        }),
        { numRuns: 100 },
      );
    });

    // Validates: Requirements 4.6
    test("a fresh store returns an empty list", () => {
      const store = createTestStore();
      expect(store.list()).toEqual([]);
      expect(store.list().length).toBe(0);
    });

    // Validates: Requirements 4.1, 4.2, 4.3, 4.4
    test("a new store over the same database still reflects previously written data", () => {
      const { sqlite, store } = createTestStoreWithDb();

      store.upsert("ALPHA", "first-value", "first description");
      store.upsert("BETA", "second-value");

      // A brand-new VariableStore over the SAME underlying SQLite connection.
      const reopened = new VariableStore(drizzle(sqlite));
      const listed = reopened.list();

      expect(listed.length).toBe(2);

      const alpha = listed.find((entry) => entry.key === "ALPHA");
      const beta = listed.find((entry) => entry.key === "BETA");

      expect(alpha).not.toBeUndefined();
      expect(alpha!.value).toBe("first-value");
      expect(alpha!.description).toBe("first description");

      expect(beta).not.toBeUndefined();
      expect(beta!.value).toBe("second-value");
      expect(beta!.description ?? "").toBe("");
    });
  });
});
