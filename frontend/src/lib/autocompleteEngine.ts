import type { Suggestion } from "./templateScope";

/**
 * Result of trigger detection - describes the autocomplete context.
 */
export interface TriggerContext {
  /** Whether an unclosed `{{` was found before the cursor */
  active: boolean;
  /** The resolved path segments (e.g. ["steps", "fetch"]) */
  path: string[];
  /** The text typed after the last `.` (the current filter prefix) */
  prefix: string;
  /** Character offset of the `{{` trigger in the field text (-1 if inactive) */
  triggerOffset: number;
}

/**
 * Result of computing what text to insert when a suggestion is accepted.
 */
export interface InsertionResult {
  /** The new complete field value after insertion */
  newText: string;
  /** The new cursor position in the field */
  newCursorPos: number;
  /** Whether the popup should remain open (non-terminal) */
  keepOpen: boolean;
}

/**
 * Detects whether the cursor is in an active template trigger context.
 *
 * Scans backwards from cursorPos to find an unclosed `{{`.
 * Returns inactive if:
 * - No `{{` found before cursor
 * - A `}}` appears between the `{{` and the cursor position (meaning the expression is already closed before cursor)
 *
 * @param text - The full field text
 * @param cursorPos - The current cursor position (0-based)
 * @returns TriggerContext describing the autocomplete state
 */
export function detectTrigger(text: string, cursorPos: number): TriggerContext {
  const inactive: TriggerContext = {
    active: false,
    path: [],
    prefix: "",
    triggerOffset: -1,
  };

  // Scan backwards from cursor to find the nearest `{{`
  let triggerOffset = -1;
  for (let i = cursorPos - 1; i >= 1; i--) {
    if (text[i] === "{" && text[i - 1] === "{") {
      triggerOffset = i - 1;
      break;
    }
  }

  if (triggerOffset === -1) {
    return inactive;
  }

  // Check if this `{{` is already closed by a `}}` between it and the cursor.
  // If so, the expression is complete and autocomplete should not trigger.
  const betweenTriggerAndCursor = text.slice(triggerOffset + 2, cursorPos);
  if (betweenTriggerAndCursor.includes("}}")) {
    return inactive;
  }

  // Extract the expression content between `{{` and cursor
  const content = text.slice(triggerOffset + 2, cursorPos);

  // Split by `.` to get segments
  const segments = content.split(".");

  // Last segment is the prefix (what user is currently typing)
  const prefix = segments[segments.length - 1] ?? "";

  // All previous segments form the path
  const path = segments.slice(0, -1);

  return {
    active: true,
    path,
    prefix,
    triggerOffset,
  };
}

/**
 * Computes the text insertion for an accepted suggestion.
 *
 * For terminal suggestions: replaces the typed prefix with label + `}}`
 * For non-terminal suggestions: replaces the typed prefix with label + `.`
 *
 * @param text - Current field text
 * @param cursorPos - Current cursor position
 * @param _triggerOffset - Offset of the `{{` trigger (kept for API symmetry)
 * @param suggestion - The accepted suggestion
 * @param _path - Current resolved path segments (kept for API symmetry)
 * @param prefix - Current typed prefix being replaced
 * @returns InsertionResult with new text and cursor position
 */
export function computeInsertion(
  text: string,
  cursorPos: number,
  _triggerOffset: number,
  suggestion: Suggestion,
  _path: string[],
  prefix: string,
): InsertionResult {
  const prefixStart = cursorPos - prefix.length;

  // Determine how much of the current segment remains after the cursor.
  // When the cursor is mid-word (e.g. "filen|ame"), we need to consume
  // the trailing part of the segment so it gets replaced entirely.
  const afterCursor = text.slice(cursorPos);
  const segmentEndMatch = afterCursor.match(/^[^.{}]*/);
  const segmentTail = segmentEndMatch ? segmentEndMatch[0].length : 0;

  if (suggestion.terminal) {
    // Terminal: replace entire current segment with label + "}}"
    const inserted = `${suggestion.label}}}`;
    // Also skip a `}}` immediately after the segment tail to avoid duplication
    let skipAfter = segmentTail;
    if (text.slice(cursorPos + segmentTail, cursorPos + segmentTail + 2) === "}}") {
      skipAfter += 2;
    }
    const after = text.slice(cursorPos + skipAfter);
    const newText = text.slice(0, prefixStart) + inserted + after;
    const newCursorPos = prefixStart + inserted.length;
    return { newText, newCursorPos, keepOpen: false };
  }

  // Non-terminal: replace entire current segment with label + "."
  const inserted = `${suggestion.label}.`;
  // Skip the segment tail but preserve whatever comes after (dots, more segments, closing braces)
  const after = text.slice(cursorPos + segmentTail);
  const newText = text.slice(0, prefixStart) + inserted + after;
  const newCursorPos = prefixStart + inserted.length;
  return { newText, newCursorPos, keepOpen: true };
}

/**
 * Computes the next highlight index given current index, direction, and list length.
 * Wraps around: going past the end wraps to 0, going before 0 wraps to length-1.
 *
 * @param currentIndex - Current highlighted index
 * @param direction - 1 for down, -1 for up
 * @param listLength - Total number of items in the list
 * @returns New highlight index (always in [0, listLength-1])
 */
export function navigateHighlight(currentIndex: number, direction: 1 | -1, listLength: number): number {
  return (currentIndex + direction + listLength) % listLength;
}
