/**
 * Property-based tests for NavigationEntry and ExtensionUi TypeBox schemas.
 *
 * Validates Property 1 (NavigationEntry field validation) and
 * Property 2 (Optional ui field acceptance) from the design document.
 */

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import fc from "fast-check";
import { ExtensionRegistry } from "./registry";
import { ExtensionManifestSchema, ExtensionUiSchema, NavigationEntrySchema } from "./types";

/**
 * Validates: Requirements 1.1, 1.3
 *
 * Property 1: For any NavigationEntry object, the TypeBox schema SHALL accept it
 * if and only if: label is 1-50 characters, route starts with `/` and is 1-128
 * characters, icon is 1-64 characters, order is an integer 0-999, and badgeKey
 * (if present) is 1-64 characters matching `^[a-zA-Z][a-zA-Z0-9_.:-]*$`.
 * Additionally, a navigation array SHALL be accepted if and only if it contains
 * at most 10 entries.
 */
describe("NavigationEntrySchema", () => {
  // Generator for valid NavigationEntry objects
  const validNavEntry = fc.record({
    label: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.length >= 1),
    route: fc
      .string({ minLength: 0, maxLength: 127 })
      .map((s) => `/${s.replace(/\n/g, "")}`)
      .filter((s) => s.length >= 1 && s.length <= 128),
    icon: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length >= 1),
    order: fc.integer({ min: 0, max: 999 }),
    badgeKey: fc.option(
      fc
        .tuple(
          fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")),
          fc
            .array(
              fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:- ".split("")),
              { minLength: 0, maxLength: 62 },
            )
            .map((arr) => arr.filter((c) => /[a-zA-Z0-9_.:-]/.test(c)).join("")),
        )
        .map(([first, rest]) => `${first}${rest}`)
        .filter((s) => s.length >= 1 && s.length <= 64),
      { nil: undefined },
    ),
  });

  test("accepts all valid NavigationEntry objects", () => {
    fc.assert(
      fc.property(validNavEntry, (entry) => {
        const result = Value.Check(NavigationEntrySchema, entry);
        expect(result).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  test("rejects entries with empty label", () => {
    fc.assert(
      fc.property(validNavEntry, (entry) => {
        const invalid = { ...entry, label: "" };
        expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("rejects entries with label exceeding 50 characters", () => {
    fc.assert(
      fc.property(validNavEntry, fc.string({ minLength: 51, maxLength: 100 }), (entry, longLabel) => {
        const invalid = { ...entry, label: longLabel };
        expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("rejects entries with route not starting with /", () => {
    fc.assert(
      fc.property(
        validNavEntry,
        fc.string({ minLength: 1, maxLength: 128 }).filter((s) => !s.startsWith("/") && s.length >= 1),
        (entry, badRoute) => {
          const invalid = { ...entry, route: badRoute };
          expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("rejects entries with empty route", () => {
    fc.assert(
      fc.property(validNavEntry, (entry) => {
        const invalid = { ...entry, route: "" };
        expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("rejects entries with route exceeding 128 characters", () => {
    fc.assert(
      fc.property(validNavEntry, (entry) => {
        const longRoute = `/${"a".repeat(128)}`;
        const invalid = { ...entry, route: longRoute };
        expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("rejects entries with empty icon", () => {
    fc.assert(
      fc.property(validNavEntry, (entry) => {
        const invalid = { ...entry, icon: "" };
        expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("rejects entries with icon exceeding 64 characters", () => {
    fc.assert(
      fc.property(validNavEntry, (entry) => {
        const invalid = { ...entry, icon: "x".repeat(65) };
        expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("rejects entries with order below 0", () => {
    fc.assert(
      fc.property(validNavEntry, fc.integer({ min: -1000, max: -1 }), (entry, negativeOrder) => {
        const invalid = { ...entry, order: negativeOrder };
        expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("rejects entries with order above 999", () => {
    fc.assert(
      fc.property(validNavEntry, fc.integer({ min: 1000, max: 10000 }), (entry, highOrder) => {
        const invalid = { ...entry, order: highOrder };
        expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("rejects entries with non-integer order", () => {
    fc.assert(
      fc.property(
        validNavEntry,
        fc.double({ min: 0.01, max: 998.99, noNaN: true }).filter((n) => !Number.isInteger(n)),
        (entry, floatOrder) => {
          const invalid = { ...entry, order: floatOrder };
          expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("rejects entries with invalid badgeKey pattern", () => {
    fc.assert(
      fc.property(
        validNavEntry,
        fc.constantFrom("1startsWithDigit", "_underscore", ".dot", "-dash", "has space", "!bang"),
        (entry, badKey) => {
          const invalid = { ...entry, badgeKey: badKey };
          expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("rejects entries with empty badgeKey", () => {
    fc.assert(
      fc.property(validNavEntry, (entry) => {
        const invalid = { ...entry, badgeKey: "" };
        expect(Value.Check(NavigationEntrySchema, invalid)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("ExtensionUiSchema", () => {
  const validNavEntry = fc.record({
    label: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.length >= 1),
    route: fc
      .string({ minLength: 0, maxLength: 127 })
      .map((s) => `/${s.replace(/\n/g, "")}`)
      .filter((s) => s.length >= 1 && s.length <= 128),
    icon: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length >= 1),
    order: fc.integer({ min: 0, max: 999 }),
  });

  test("accepts navigation arrays with 0 to 10 items", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }).chain((len) => fc.array(validNavEntry, { minLength: len, maxLength: len })),
        (navigation) => {
          const ui = { navigation };
          expect(Value.Check(ExtensionUiSchema, ui)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("rejects navigation arrays exceeding 10 items", () => {
    fc.assert(
      fc.property(fc.array(validNavEntry, { minLength: 11, maxLength: 20 }), (navigation) => {
        const ui = { navigation };
        expect(Value.Check(ExtensionUiSchema, ui)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Validates: Requirements 1.2
 *
 * Property 2: For any valid extension manifest (valid name, version, etc.), the
 * manifest SHALL pass validation both when the ui field is present with a valid
 * structure and when the ui field is absent.
 */
describe("ExtensionManifestSchema - optional ui field", () => {
  const validName = fc
    .tuple(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")), {
          minLength: 0,
          maxLength: 15,
        })
        .map((arr) => arr.join("")),
    )
    .map(([first, rest]) => `${first}${rest}`);

  const validVersion = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length >= 1);

  const validNavEntry = fc.record({
    label: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.length >= 1),
    route: fc
      .string({ minLength: 0, maxLength: 127 })
      .map((s) => `/${s.replace(/\n/g, "")}`)
      .filter((s) => s.length >= 1 && s.length <= 128),
    icon: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length >= 1),
    order: fc.integer({ min: 0, max: 999 }),
  });

  const validUi = fc.record({
    navigation: fc.array(validNavEntry, { minLength: 0, maxLength: 10 }),
  });

  test("accepts manifests with a valid ui field", () => {
    fc.assert(
      fc.property(validName, validVersion, validUi, (name, version, ui) => {
        const manifest = { name, version, ui };
        expect(Value.Check(ExtensionManifestSchema, manifest)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  test("accepts manifests without a ui field", () => {
    fc.assert(
      fc.property(validName, validVersion, (name, version) => {
        const manifest = { name, version };
        expect(Value.Check(ExtensionManifestSchema, manifest)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  test("rejects manifests with an invalid ui field", () => {
    fc.assert(
      fc.property(
        validName,
        validVersion,
        fc.array(validNavEntry, { minLength: 11, maxLength: 15 }),
        (name, version, navigation) => {
          const manifest = { name, version, ui: { navigation } };
          expect(Value.Check(ExtensionManifestSchema, manifest)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Validates: Requirements 1.5
 *
 * Property 3: For any manifest containing a `ui.navigation` array where two or
 * more entries share the same `route` value, the registry SHALL reject the
 * manifest with a validation error.
 */
describe("Duplicate route rejection within manifest", () => {
  const registry = new ExtensionRegistry({
    extensionDirs: [],
    workDir: "/tmp/test",
    dataDir: "/tmp/test-data",
  });

  /** Helper to build a full valid extension object for validateExtension(). */
  function makeExtension(navigation: Array<{ label: string; route: string; icon: string; order: number }>) {
    return {
      manifest: { name: "test-ext", version: "1.0.0", ui: { navigation } },
      initialize: async () => {},
      shutdown: async () => {},
    };
  }

  const validNavEntry = (route: string) =>
    fc.record({
      label: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.length >= 1),
      route: fc.constant(route),
      icon: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length >= 1),
      order: fc.integer({ min: 0, max: 999 }),
    });

  const validRoute = fc
    .string({ minLength: 0, maxLength: 126 })
    .map((s) => `/${s.replace(/\n/g, "")}`)
    .filter((s) => s.length >= 1 && s.length <= 128);

  /**
   * Generates a navigation array guaranteed to contain at least one duplicate route.
   */
  const navArrayWithDuplicateRoute = validRoute.chain((duplicateRoute) =>
    fc
      .tuple(
        validNavEntry(duplicateRoute),
        validNavEntry(duplicateRoute),
        fc.array(
          fc.record({
            label: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.length >= 1),
            route: validRoute.filter((r) => r !== duplicateRoute),
            icon: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length >= 1),
            order: fc.integer({ min: 0, max: 999 }),
          }),
          { minLength: 0, maxLength: 7 },
        ),
      )
      .map(([dup1, dup2, others]) => [...others, dup1, dup2]),
  );

  test("rejects manifests with duplicate routes in ui.navigation", () => {
    fc.assert(
      fc.property(navArrayWithDuplicateRoute, (navigation) => {
        // Trim to 10 to satisfy TypeBox maxItems, skip if no duplicates remain
        const trimmed = navigation.slice(0, 10);
        const routes = trimmed.map((e) => e.route);
        if (new Set(routes).size === routes.length) return;

        const ext = makeExtension(trimmed);
        expect(registry.validateExtension(ext, "test.ts")).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  test("accepts manifests without duplicate routes in ui.navigation", () => {
    const uniqueNavArray = fc
      .array(validRoute, { minLength: 1, maxLength: 10 })
      .map((routes) => [...new Set(routes)])
      .filter((routes) => routes.length >= 1)
      .chain((routes) =>
        fc.tuple(
          ...routes.map((route) =>
            fc.record({
              label: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.length >= 1),
              route: fc.constant(route),
              icon: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length >= 1),
              order: fc.integer({ min: 0, max: 999 }),
            }),
          ),
        ),
      );

    fc.assert(
      fc.property(uniqueNavArray, (navigation) => {
        const ext = makeExtension(navigation);
        expect(registry.validateExtension(ext, "test.ts")).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
