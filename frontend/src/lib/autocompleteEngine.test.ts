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
     * The remainder of the current segment (chars after cursor up to the next `.` or `}}`)
     * is consumed/replaced by the insertion.
     */
    test("terminal suggestion inserts label + }} and keepOpen is false", () => {
      fc.assert(
        fc.property(
          safeTextArb,
          fc.array(segmentArb, { minLength: 0, maxLength: 3 }),
          prefixArb,
          terminalSuggestionArb,
          segmentArb, // segment tail (part of current segment after cursor)
          safeTextArb, // true trailing text after the segment boundary
          (before, path, prefix, suggestion, segTail, trailingText) => {
            // Build a valid context: before + "{{" + path + prefix + segTail + "." + trailingText
            // The segTail simulates cursor being mid-segment; boundary is the "."
            const pathStr = path.length > 0 ? `${path.join(".")}.` : "";
            const text = `${before}{{${pathStr}${prefix}${segTail}.${trailingText}`;
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
     * The remainder of the current segment (chars after cursor up to the next `.` or `}}`)
     * is consumed/replaced by the insertion.
     */
    test("non-terminal suggestion inserts label + . and keepOpen is true", () => {
      fc.assert(
        fc.property(
          safeTextArb,
          fc.array(segmentArb, { minLength: 0, maxLength: 3 }),
          prefixArb,
          nonTerminalSuggestionArb,
          segmentArb, // segment tail (part of current segment after cursor)
          safeTextArb, // true trailing text after the segment boundary
          (before, path, prefix, suggestion, segTail, trailingText) => {
            // Build text with a boundary after the segment tail
            const pathStr = path.length > 0 ? `${path.join(".")}.` : "";
            const text = `${before}{{${pathStr}${prefix}${segTail}.${trailingText}`;
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

            // Cursor is positioned after the inserted label + .
            expect(result.newCursorPos).toBe(insertStart + suggestion.label.length + 1);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Function context classification and insertion", () => {
    /**
     * These example-based tests lock the new function-syntax behavior:
     * detectTrigger classifies path vs argument context, and computeInsertion
     * inserts `name(` for function suggestions while keeping the popup open.
     * They also assert the no-regression cases: a plain dot-path expression
     * still classifies as `kind: "path"` with the identical path/prefix.
     */

    test("no-regression: plain expression classifies as path with unchanged path/prefix", () => {
      const text = "{{ steps.fetch.re";
      const result = detectTrigger(text, text.length);
      expect(result.active).toBe(true);
      expect(result.kind).toBe("path");
      // Leading whitespace after `{{` is trimmed before dot-splitting.
      expect(result.path).toEqual(["steps", "fetch"]);
      expect(result.prefix).toBe("re");
      expect(result.functionName).toBeUndefined();
    });

    test("no-regression: top-level value position (right after {{)", () => {
      const text = "{{ ";
      const result = detectTrigger(text, text.length);
      expect(result.active).toBe(true);
      expect(result.kind).toBe("path");
      expect(result.path).toEqual([]);
      expect(result.prefix).toBe("");
    });

    test("cursor inside ( classifies as argument at start of first argument", () => {
      const text = "{{ stripDataUri(";
      const result = detectTrigger(text, text.length);
      expect(result.active).toBe(true);
      expect(result.kind).toBe("argument");
      expect(result.functionName).toBe("stripDataUri");
      expect(result.argumentIndex).toBe(0);
      expect(result.path).toEqual([]);
      expect(result.prefix).toBe("");
    });

    test("argument interior resolves its inner path exactly like a bare path", () => {
      const text = "{{ stripDataUri(image.da";
      const result = detectTrigger(text, text.length);
      expect(result.kind).toBe("argument");
      expect(result.functionName).toBe("stripDataUri");
      expect(result.path).toEqual(["image"]);
      expect(result.prefix).toBe("da");
    });

    test("cursor after a comma classifies as the next argument", () => {
      const text = "{{ after(image.url, ";
      const result = detectTrigger(text, text.length);
      expect(result.kind).toBe("argument");
      expect(result.functionName).toBe("after");
      expect(result.argumentIndex).toBe(1);
      expect(result.path).toEqual([]);
      expect(result.prefix).toBe("");
    });

    test("nested call reports the innermost function and its argument", () => {
      const text = "{{ jsonEscape(stripDataUri(image.da";
      const result = detectTrigger(text, text.length);
      expect(result.kind).toBe("argument");
      expect(result.functionName).toBe("stripDataUri");
      expect(result.argumentIndex).toBe(0);
      expect(result.path).toEqual(["image"]);
      expect(result.prefix).toBe("da");
    });

    test("cursor after a closed inner call returns to the outer argument context", () => {
      const text = "{{ jsonEscape(stripDataUri(image.dataUrl)";
      const result = detectTrigger(text, text.length);
      expect(result.kind).toBe("argument");
      expect(result.functionName).toBe("jsonEscape");
      expect(result.argumentIndex).toBe(0);
    });

    test("computeInsertion for a function inserts name( and keeps popup open", () => {
      const text = "{{ st";
      const cursorPos = text.length;
      const suggestion: Suggestion = { label: "stripDataUri", terminal: false, kind: "function" };
      const result = computeInsertion(text, cursorPos, 0, suggestion, [], "st");
      expect(result.newText).toBe("{{ stripDataUri(");
      expect(result.newCursorPos).toBe("{{ stripDataUri(".length);
      expect(result.keepOpen).toBe(true);
    });

    test("computeInsertion for a function does not duplicate an existing open paren", () => {
      const text = "{{ st(";
      // Cursor sits right after the typed prefix "st", before the existing "(".
      const cursorPos = "{{ st".length;
      const suggestion: Suggestion = { label: "stripDataUri", terminal: false, kind: "function" };
      const result = computeInsertion(text, cursorPos, 0, suggestion, [], "st");
      expect(result.newText).toBe("{{ stripDataUri(");
      expect(result.keepOpen).toBe(true);
    });

    test("accepting a terminal value inside a call closes the paren before the braces", () => {
      // Reproduces the reported bug: completing `payload` inside `base64Decode(`
      // must produce a balanced `...payload)}}`, not `...payload}}`.
      const text = "{{base64Decode(trigger.payload";
      const cursorPos = text.length;
      const suggestion: Suggestion = { label: "payload", terminal: true };
      const result = computeInsertion(text, cursorPos, 0, suggestion, ["trigger"], "payload");
      expect(result.newText).toBe("{{base64Decode(trigger.payload)}}");
      expect(result.keepOpen).toBe(false);
    });

    test("terminal value closes multiple nested open parens before the braces", () => {
      const text = "{{jsonEscape(stripDataUri(image.dataUrl";
      const cursorPos = text.length;
      const suggestion: Suggestion = { label: "dataUrl", terminal: true };
      const result = computeInsertion(text, cursorPos, 0, suggestion, ["image"], "dataUrl");
      expect(result.newText).toBe("{{jsonEscape(stripDataUri(image.dataUrl))}}");
      expect(result.keepOpen).toBe(false);
    });

    test("terminal value does not duplicate a paren the author already closed", () => {
      // Author already typed the closing paren; completion should not add another.
      const text = "{{base64Decode(trigger.payload)";
      const cursorPos = "{{base64Decode(trigger.payload".length; // caret before the ")"
      const suggestion: Suggestion = { label: "payload", terminal: true };
      const result = computeInsertion(text, cursorPos, 0, suggestion, ["trigger"], "payload");
      expect(result.newText).toBe("{{base64Decode(trigger.payload)}}");
      expect(result.keepOpen).toBe(false);
    });

    test("terminal value outside any call is unaffected (no extra parens)", () => {
      const text = "{{trigger.payload";
      const cursorPos = text.length;
      const suggestion: Suggestion = { label: "payload", terminal: true };
      const result = computeInsertion(text, cursorPos, 0, suggestion, ["trigger"], "payload");
      expect(result.newText).toBe("{{trigger.payload}}");
      expect(result.keepOpen).toBe(false);
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
