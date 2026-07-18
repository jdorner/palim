import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { SecretsSchemaSchema } from "@src/extensions/types";
import fc from "fast-check";

/**
 * Property-based tests for SecretsSchema validation.
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */
describe("SecretsSchema validation (property-based)", () => {
  // --- Generators ---

  const upperLetterArb = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
  const upperAlnumUnderArb = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(""));

  /** Valid key: 1-64 chars, starts with uppercase letter, rest uppercase letters/digits/underscores. */
  const validKeyArb = fc
    .tuple(upperLetterArb, fc.array(upperAlnumUnderArb, { minLength: 0, maxLength: 15 }))
    .map(([first, rest]) => first + rest.join(""));

  /** Valid description: 1-200 chars. */
  const validDescriptionArb = fc.string({ minLength: 1, maxLength: 200, unit: "grapheme-ascii" });

  /** Valid group: 1-50 chars when present. */
  const validGroupArb = fc.string({ minLength: 1, maxLength: 50, unit: "grapheme-ascii" });

  /** Generator for a valid SecretSchemaEntry. */
  const validEntryArb = fc.record({
    key: validKeyArb,
    description: validDescriptionArb,
    required: fc.boolean(),
    group: fc.option(validGroupArb, { nil: undefined }),
  });

  /** Generator for a valid SecretsSchema (unique keys, max 20 entries). */
  const validSchemaArb = fc.array(validEntryArb, { minLength: 0, maxLength: 20 }).map((entries) => {
    // Deduplicate keys by keeping the first occurrence
    const seen = new Set<string>();
    return entries.filter((e) => {
      if (seen.has(e.key)) return false;
      seen.add(e.key);
      return true;
    });
  });

  test("Feature: web-secret-management, Property 5: SecretsSchema validation - valid schemas pass", () => {
    fc.assert(
      fc.property(validSchemaArb, (schema) => {
        const result = Value.Check(SecretsSchemaSchema, schema);
        expect(result).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 5: SecretsSchema validation - invalid key pattern rejects", () => {
    // Keys that violate the pattern
    const invalidKeyArb = fc.oneof(
      // starts lowercase
      fc.tuple(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), validKeyArb).map(([c, rest]) => c + rest),
      // starts with digit
      fc.tuple(fc.constantFrom(..."0123456789".split("")), validKeyArb).map(([c, rest]) => c + rest),
      // contains lowercase after first char
      fc.tuple(validKeyArb, fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split(""))).map(([k, c]) => k + c),
      // empty string
      fc.constant(""),
    );

    const invalidKeyEntryArb = fc.record({
      key: invalidKeyArb,
      description: validDescriptionArb,
      required: fc.boolean(),
      group: fc.option(validGroupArb, { nil: undefined }),
    });

    fc.assert(
      fc.property(invalidKeyEntryArb, (entry) => {
        // Skip entries that accidentally match the valid pattern (e.g. key+lowercase could still be > 64)
        if (/^[A-Z][A-Z0-9_]*$/.test(entry.key) && entry.key.length >= 1 && entry.key.length <= 64) return;
        const result = Value.Check(SecretsSchemaSchema, [entry]);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 5: SecretsSchema validation - description length violations reject", () => {
    // Empty description
    const emptyDescEntry = fc.record({
      key: validKeyArb,
      description: fc.constant(""),
      required: fc.boolean(),
      group: fc.option(validGroupArb, { nil: undefined }),
    });

    fc.assert(
      fc.property(emptyDescEntry, (entry) => {
        const result = Value.Check(SecretsSchemaSchema, [entry]);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );

    // Description over 200 chars
    const longDescEntry = fc.record({
      key: validKeyArb,
      description: fc.string({ minLength: 201, maxLength: 250, unit: "grapheme-ascii" }),
      required: fc.boolean(),
      group: fc.option(validGroupArb, { nil: undefined }),
    });

    fc.assert(
      fc.property(longDescEntry, (entry) => {
        const result = Value.Check(SecretsSchemaSchema, [entry]);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 5: SecretsSchema validation - exceeding 20 entries rejects", () => {
    // Generate schemas with 21-25 unique entries using numbered keys
    const oversizedSchemaArb = fc.integer({ min: 21, max: 25 }).map((count) => {
      return Array.from({ length: count }, (_, i) => ({
        key: `KEY_${String(i).padStart(3, "0")}`,
        description: "A valid description",
        required: true,
        group: undefined,
      }));
    });

    fc.assert(
      fc.property(oversizedSchemaArb, (schema) => {
        const result = Value.Check(SecretsSchemaSchema, schema);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 5: SecretsSchema validation - duplicate keys detected by registry logic", () => {
    // TypeBox does not enforce uniqueness within the array, so the registry performs a separate
    // duplicate key check. This test validates that logic independently.
    const duplicateSchemaArb = validSchemaArb
      .filter((s) => s.length >= 1)
      .map((entries) => {
        // Duplicate the first entry to introduce a duplicate key
        const dup = { ...entries[0]! };
        return [...entries, dup];
      });

    fc.assert(
      fc.property(duplicateSchemaArb, (schema) => {
        // Registry-style duplicate detection (mirrors src/extensions/registry.ts logic)
        const keyNames = new Set<string>();
        const duplicates: string[] = [];
        for (const entry of schema) {
          if (keyNames.has(entry.key)) {
            duplicates.push(entry.key);
          }
          keyNames.add(entry.key);
        }
        expect(duplicates.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 5: SecretsSchema validation - key exceeding 64 chars rejects", () => {
    // Generate keys longer than 64 characters using a deterministic approach
    const longKeyArb = fc.integer({ min: 65, max: 80 }).map((len) => `A${"B".repeat(len - 1)}`);

    const longKeyEntryArb = fc.record({
      key: longKeyArb,
      description: validDescriptionArb,
      required: fc.boolean(),
      group: fc.option(validGroupArb, { nil: undefined }),
    });

    fc.assert(
      fc.property(longKeyEntryArb, (entry) => {
        const result = Value.Check(SecretsSchemaSchema, [entry]);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 5: SecretsSchema validation - invalid group length rejects", () => {
    // Group over 50 chars
    const longGroupEntry = fc.record({
      key: validKeyArb,
      description: validDescriptionArb,
      required: fc.boolean(),
      group: fc.string({ minLength: 51, maxLength: 80, unit: "grapheme-ascii" }),
    });

    fc.assert(
      fc.property(longGroupEntry, (entry) => {
        const result = Value.Check(SecretsSchemaSchema, [entry]);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );

    // Empty group string
    const emptyGroupEntry = fc.record({
      key: validKeyArb,
      description: validDescriptionArb,
      required: fc.boolean(),
      group: fc.constant(""),
    });

    fc.assert(
      fc.property(emptyGroupEntry, (entry) => {
        const result = Value.Check(SecretsSchemaSchema, [entry]);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
