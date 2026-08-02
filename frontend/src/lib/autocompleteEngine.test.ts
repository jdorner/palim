import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { computeInsertion, detectTrigger, navigateHighlight } from "./autocompleteEngine";
import type { Suggestion } from "./templateScope";

/**
 * Generators for autocomplete engine property tests.
 */

/** Generates a simple identifier-like label for suggestions. */
const labelArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);

/** Generates a terminal suggestion. */
const terminalSuggestionArb: fc.Arbitrary<Suggestion> = labelArb.map((label) => ({
  label,
  terminal: true,
}));

/** Generates a non-terminal suggestion. */
const nonTerminalSuggestionArb: fc.Arbitrary<Suggestion> = labelArb.map((label) => ({
  label,
  terminal: false,
}));

/** Generates safe text content (no template braces). */
const safeTextArb = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz .0123456789".split("")),
  minLength: 0,
  maxLength: 30,
});

/** Generates a path segment (like a namespace or slug). */
const segmentArb = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);

/** Generates a prefix (partial typed text). */
const prefixArb = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
  minLength: 0,
  maxLength: 8,
});

describe("Autocomplete Engine - Property Tests", () => {
  describe("Property 1: Trigger detection correctness", () => {
    /**
     * Validates: Requirements 1.4, 1.5, 1.6
     *
     * For any string text and cursor position cursorPos, if there is no substring
     * `{{` at any position i < cursorPos such that no `}}` appears between i and
     * cursorPos, then detectTrigger(text, cursorPos).active SHALL be false.
     */
    test("inactive when no {{ exists before cursor", () => {
      fc.assert(
        fc.property(safeTextArb, safeTextArb, (before, after) => {
          // Text without any `{{` at all - must be inactive at any cursor position
          const text = before + after;
          const cursorPos = before.length;
          const result = detectTrigger(text, cursorPos);
          expect(result.active).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    test("inactive when {{ is closed by }} before cursor", () => {
      fc.assert(
        fc.property(safeTextArb, safeTextArb, safeTextArb, (before, middle, after) => {
          // Text with a closed expression `{{...}}` - cursor at end means }} is between {{ and cursor
          const text = `${before}{{${middle}}}${after}`;
          const cursorPos = text.length;
          const result = detectTrigger(text, cursorPos);
          expect(result.active).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    test("active when cursor is between {{ and }} (editing inside expression)", () => {
      fc.assert(
        fc.property(safeTextArb, segmentArb, safeTextArb, (before, content, after) => {
          // Text like: before + "{{" + content + "}}" + after
          // Cursor positioned right after content (before the }})
          const text = `${before}{{${content}}}${after}`;
          const cursorPos = before.length + 2 + content.length;
          const result = detectTrigger(text, cursorPos);
          expect(result.active).toBe(true);
          expect(result.triggerOffset).toBe(before.length);
        }),
        { numRuns: 100 },
      );
    });

    test("active when {{ is unclosed before cursor", () => {
      fc.assert(
        fc.property(safeTextArb, segmentArb, (before, content) => {
          // Text with an unclosed `{{` and cursor at end (no `}}` anywhere after)
          const text = `${before}{{${content}`;
          const cursorPos = text.length;
          const result = detectTrigger(text, cursorPos);
          expect(result.active).toBe(true);
          expect(result.triggerOffset).toBe(before.length);
        }),
        { numRuns: 100 },
      );
    });

    test("parses path and prefix correctly from unclosed trigger", () => {
      fc.assert(
        fc.property(
          safeTextArb,
          fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
          prefixArb,
          (before, pathSegments, prefix) => {
            // Build text like: before + "{{" + "seg1.seg2." + prefix
            const pathStr = pathSegments.join(".");
            const text = `${before}{{${pathStr}.${prefix}`;
            const cursorPos = text.length;
            const result = detectTrigger(text, cursorPos);

            expect(result.active).toBe(true);
            expect(result.path).toEqual(pathSegments);
            expect(result.prefix).toBe(prefix);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Property 6: Terminal insertion appends closing braces", () => {
    /**
     * Validates: Requirements 7.1, 7.6, 7.7, 7.8, 7.9
     *
     * For any terminal Suggestion and any valid (text, cursorPos, triggerOffset, path, prefix)
     * tuple, computeInsertion(...) SHALL produce a newText where the characters at the insertion
     * point end with suggestion.label + "}}", and keepOpen SHALL be false.
     */
    test("terminal suggestion inserts label + }} and keepOpen is false", () => {
      fc.assert(
        fc.property(
          safeTextArb,
          fc.array(segmentArb, { minLength: 0, maxLength: 3 }),
          prefixArb,
          terminalSuggestionArb,
          safeTextArb,
          (before, path, prefix, suggestion, after) => {
            // Build a valid context: before + "{{" + path.join(".") + "." + prefix + after
            const pathStr = path.length > 0 ? `${path.join(".")}.` : "";
            const text = `${before}{{${pathStr}${prefix}${after}`;
            const triggerOffset = before.length;
            const cursorPos = before.length + 2 + pathStr.length + prefix.length;

            const result = computeInsertion(text, cursorPos, triggerOffset, suggestion, path, prefix);

            // keepOpen must be false for terminal
            expect(result.keepOpen).toBe(false);

            // The newText at the insertion region must contain label + "}}"
            const insertStart = cursorPos - prefix.length;
            const insertedRegion = result.newText.slice(insertStart, insertStart + suggestion.label.length + 2);
            expect(insertedRegion).toBe(`${suggestion.label}}}`);

            // Text before the insertion point is preserved
            expect(result.newText.slice(0, insertStart)).toBe(text.slice(0, insertStart));

            // Text after the insertion is preserved
            expect(result.newText.slice(insertStart + suggestion.label.length + 2)).toBe(after);

            // Cursor is positioned after the inserted label + }}
            expect(result.newCursorPos).toBe(insertStart + suggestion.label.length + 2);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Property 6b: Terminal insertion consumes existing }}", () => {
    /**
     * Validates: Requirements 7.1, 7.6, 7.7, 7.8, 7.9
     *
     * When the cursor is inside an existing expression (text has `}}` immediately
     * after the cursor), accepting a terminal suggestion should consume those
     * closing braces to avoid double `}}}}`.
     */
    test("terminal suggestion consumes existing }} after cursor", () => {
      fc.assert(
        fc.property(
          safeTextArb,
          fc.array(segmentArb, { minLength: 0, maxLength: 3 }),
          prefixArb,
          terminalSuggestionArb,
          safeTextArb,
          (before, path, prefix, suggestion, after) => {
            // Build text with existing }} after cursor: before + "{{" + path + prefix + "}}" + after
            const pathStr = path.length > 0 ? `${path.join(".")}.` : "";
            const text = `${before}{{${pathStr}${prefix}}}${after}`;
            const triggerOffset = before.length;
            const cursorPos = before.length + 2 + pathStr.length + prefix.length;

            const result = computeInsertion(text, cursorPos, triggerOffset, suggestion, path, prefix);

            // Should NOT have double }}
            expect(result.keepOpen).toBe(false);

            // The newText at the insertion region must contain label + "}}"
            const insertStart = cursorPos - prefix.length;
            const insertedRegion = result.newText.slice(insertStart, insertStart + suggestion.label.length + 2);
            expect(insertedRegion).toBe(`${suggestion.label}}}`);

            // The text after the insertion should be `after` (the }} was consumed)
            expect(result.newText.slice(insertStart + suggestion.label.length + 2)).toBe(after);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Property 7: Non-terminal insertion appends dot", () => {
    /**
     * Validates: Requirements 7.2, 7.3, 7.4, 7.5
     *
     * For any non-terminal Suggestion and any valid (text, cursorPos, triggerOffset, path, prefix)
     * tuple, computeInsertion(...) SHALL produce a newText where the characters at the insertion
     * point end with suggestion.label + ".", and keepOpen SHALL be true.
     */
    test("non-terminal suggestion inserts label + . and keepOpen is true", () => {
      fc.assert(
        fc.property(
          safeTextArb,
          fc.array(segmentArb, { minLength: 0, maxLength: 3 }),
          prefixArb,
          nonTerminalSuggestionArb,
          safeTextArb,
          (before, path, prefix, suggestion, after) => {
            const pathStr = path.length > 0 ? `${path.join(".")}.` : "";
            const text = `${before}{{${pathStr}${prefix}${after}`;
            const triggerOffset = before.length;
            const cursorPos = before.length + 2 + pathStr.length + prefix.length;

            const result = computeInsertion(text, cursorPos, triggerOffset, suggestion, path, prefix);

            // keepOpen must be true for non-terminal
            expect(result.keepOpen).toBe(true);

            // The newText at the insertion region must contain label + "."
            const insertStart = cursorPos - prefix.length;
            const insertedRegion = result.newText.slice(insertStart, insertStart + suggestion.label.length + 1);
            expect(insertedRegion).toBe(`${suggestion.label}.`);

            // Text before the insertion point is preserved
            expect(result.newText.slice(0, insertStart)).toBe(text.slice(0, insertStart));

            // Text after the insertion is preserved
            expect(result.newText.slice(insertStart + suggestion.label.length + 1)).toBe(after);

            // Cursor is positioned after the inserted label + .
            expect(result.newCursorPos).toBe(insertStart + suggestion.label.length + 1);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Property 8: Highlight navigation always stays in bounds", () => {
    /**
     * Validates: Requirements 8.1, 8.2, 8.4, 8.5, 8.7
     *
     * For any list length L > 0, any starting index i in [0, L-1], and any direction
     * d in {-1, 1}, navigateHighlight(i, d, L) SHALL return a value in [0, L-1].
     * Additionally, navigateHighlight(L-1, 1, L) SHALL equal 0 (wrap down)
     * and navigateHighlight(0, -1, L) SHALL equal L-1 (wrap up).
     */
    test("result is always within [0, L-1] for any valid index and direction", () => {
      fc.assert(
        fc.property(
          fc
            .integer({ min: 1, max: 100 })
            .chain((len) => fc.tuple(fc.integer({ min: 0, max: len - 1 }), fc.constant(len))),
          fc.constantFrom(1 as const, -1 as const),
          ([startIndex, listLength], direction) => {
            const result = navigateHighlight(startIndex, direction, listLength);
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThan(listLength);
          },
        ),
        { numRuns: 100 },
      );
    });

    test("wrap down: navigateHighlight(L-1, 1, L) === 0", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 100 }), (listLength) => {
          const result = navigateHighlight(listLength - 1, 1, listLength);
          expect(result).toBe(0);
        }),
        { numRuns: 100 },
      );
    });

    test("wrap up: navigateHighlight(0, -1, L) === L-1", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 100 }), (listLength) => {
          const result = navigateHighlight(0, -1, listLength);
          expect(result).toBe(listLength - 1);
        }),
        { numRuns: 100 },
      );
    });
  });
});
