import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { getEnvSuggestions, getSecretSuggestions, getStepSlugs, getTopLevelSuggestions } from "./templateScope";

/**
 * Generators matching the design doc spec:
 * - Step slugs: /^[a-z][a-z0-9-]{0,10}$/
 * - Prefix strings: lowercase alphabet, 0-10 chars
 * - Secret keys: /^[A-Z][A-Z0-9_]{1,20}$/
 * - Env names: /^[A-Z][A-Z0-9_]{1,20}$/
 */

const lowerAlpha = "abcdefghijklmnopqrstuvwxyz";
const lowerAlphaNum = "abcdefghijklmnopqrstuvwxyz0123456789";
const slugTailChars = `${lowerAlphaNum}-`;
const upperAlpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const upperAlphaNumUnderscore = `${upperAlpha}0123456789_`;

/** Step slug: starts with [a-z], followed by 0-10 chars from [a-z0-9-] */
const slugArb = fc
  .tuple(
    fc.constantFrom(...lowerAlpha.split("")),
    fc.string({ unit: fc.constantFrom(...slugTailChars.split("")), minLength: 0, maxLength: 10 }),
  )
  .map(([first, rest]) => `${first}${rest}`);

/** Prefix: 0-10 lowercase alpha chars */
const prefixArb = fc.string({
  unit: fc.constantFrom(...lowerAlpha.split("")),
  minLength: 0,
  maxLength: 10,
});

/** Secret key: starts with [A-Z], followed by 1-20 chars from [A-Z0-9_] */
const secretKeyArb = fc
  .tuple(
    fc.constantFrom(...upperAlpha.split("")),
    fc.string({ unit: fc.constantFrom(...upperAlphaNumUnderscore.split("")), minLength: 1, maxLength: 20 }),
  )
  .map(([first, rest]) => `${first}${rest}`);

/** Env name: same pattern as secret keys */
const envNameArb = secretKeyArb;

const TOP_LEVEL_NAMESPACES = ["trigger", "steps", "env", "secret"];

describe("Template Scope Registry - Property Tests", () => {
  describe("Property 2: Prefix filtering returns only matches", () => {
    /**
     * Validates: Requirements 2.2, 2.3
     *
     * For any typed prefix string, getTopLevelSuggestions(prefix) SHALL return
     * only suggestions whose label starts with prefix (case-sensitive), and SHALL
     * return all such matches from the fixed set ["trigger", "steps", "env", "secret"].
     */
    test("returns only labels starting with prefix and all such matches", () => {
      fc.assert(
        fc.property(prefixArb, (prefix) => {
          const results = getTopLevelSuggestions(prefix);
          const labels = results.map((s) => s.label);

          // All returned labels must start with the prefix (case-sensitive)
          for (const label of labels) {
            expect(label.startsWith(prefix)).toBe(true);
          }

          // Must include ALL matches from the fixed set
          const expectedMatches = TOP_LEVEL_NAMESPACES.filter((name) => name.startsWith(prefix));
          expect(labels).toEqual(expectedMatches);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Property 3: Steps scope excludes forward references", () => {
    /**
     * Validates: Requirements 3.1, 3.2, 3.3
     *
     * For any step array of length N and any current step index i where 0 <= i < N,
     * getStepSlugs(steps, i, "") SHALL return exactly the slugs at indices 0 through
     * i-1 (inclusive), and SHALL NOT include any slug at index >= i.
     */
    test("returns exactly preceding slugs and excludes current/forward steps", () => {
      fc.assert(
        fc.property(
          fc
            .array(slugArb, { minLength: 1, maxLength: 20 })
            .chain((slugs) =>
              fc.tuple(fc.constant(slugs.map((slug) => ({ slug }))), fc.integer({ min: 0, max: slugs.length - 1 })),
            ),
          ([steps, currentIndex]) => {
            const results = getStepSlugs(steps, currentIndex, "");
            const resultLabels = results.map((s) => s.label);

            // Should contain exactly slugs at indices 0..currentIndex-1
            const expectedSlugs = steps.slice(0, currentIndex).map((s) => s.slug);
            expect(resultLabels).toEqual(expectedSlugs);

            // Verify length matches exactly (no forward references)
            expect(resultLabels.length).toBe(currentIndex);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Property 4: Suggestions are always sorted", () => {
    /**
     * Validates: Requirements 4.1, 5.2
     *
     * For any env allowlist and any set of secret keys, the suggestions returned by
     * getEnvSuggestions(envAllowlist, "") and getSecretSuggestions(secretKeys, "") SHALL
     * be in case-insensitive ascending alphabetical order of their label field.
     */
    test("env suggestions are sorted case-insensitively", () => {
      fc.assert(
        fc.property(fc.array(envNameArb, { minLength: 0, maxLength: 30 }), (envAllowlist) => {
          const results = getEnvSuggestions(envAllowlist, "");
          const labels = results.map((s) => s.label);

          for (let i = 1; i < labels.length; i++) {
            const prev = (labels[i - 1] as string).toLowerCase();
            const curr = (labels[i] as string).toLowerCase();
            expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
          }
        }),
        { numRuns: 100 },
      );
    });

    test("secret suggestions are sorted case-insensitively", () => {
      fc.assert(
        fc.property(fc.array(secretKeyArb, { minLength: 0, maxLength: 30 }), (secretKeys) => {
          const results = getSecretSuggestions(secretKeys, "");
          const labels = results.map((s) => s.label);

          for (let i = 1; i < labels.length; i++) {
            const prev = (labels[i - 1] as string).toLowerCase();
            const curr = (labels[i] as string).toLowerCase();
            expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Property 5: Env/secret filtering uses case-insensitive substring", () => {
    /**
     * Validates: Requirements 4.2, 4.3
     *
     * For any env allowlist, any secret key set, and any non-empty filter prefix,
     * the results of getEnvSuggestions(list, prefix) SHALL include only entries whose
     * label contains prefix as a case-insensitive substring, and SHALL include all
     * such entries from the source list.
     */
    test("env filtering includes only and all case-insensitive substring matches", () => {
      fc.assert(
        fc.property(
          fc.array(envNameArb, { minLength: 0, maxLength: 30 }),
          fc.string({
            unit: fc.constantFrom(...lowerAlpha.split("")),
            minLength: 1,
            maxLength: 10,
          }),
          (envAllowlist, prefix) => {
            const results = getEnvSuggestions(envAllowlist, prefix);
            const resultLabels = results.map((s) => s.label);
            const lowerPrefix = prefix.toLowerCase();

            // All returned entries must contain the prefix as case-insensitive substring
            for (const label of resultLabels) {
              expect(label.toLowerCase().includes(lowerPrefix)).toBe(true);
            }

            // All entries from the source that match must be included
            const expectedMatches = envAllowlist.filter((name) => name.toLowerCase().includes(lowerPrefix));
            expect(resultLabels.length).toBe(expectedMatches.length);
            for (const expected of expectedMatches) {
              expect(resultLabels).toContain(expected);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    test("secret filtering includes only and all case-insensitive substring matches", () => {
      fc.assert(
        fc.property(
          fc.array(secretKeyArb, { minLength: 0, maxLength: 30 }),
          fc.string({
            unit: fc.constantFrom(...lowerAlpha.split("")),
            minLength: 1,
            maxLength: 10,
          }),
          (secretKeys, prefix) => {
            const results = getSecretSuggestions(secretKeys, prefix);
            const resultLabels = results.map((s) => s.label);
            const lowerPrefix = prefix.toLowerCase();

            // All returned entries must contain the prefix as case-insensitive substring
            for (const label of resultLabels) {
              expect(label.toLowerCase().includes(lowerPrefix)).toBe(true);
            }

            // All entries from the source that match must be included
            const expectedMatches = secretKeys.filter((key) => key.toLowerCase().includes(lowerPrefix));
            expect(resultLabels.length).toBe(expectedMatches.length);
            for (const expected of expectedMatches) {
              expect(resultLabels).toContain(expected);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
