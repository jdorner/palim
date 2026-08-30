import type { Suggestion } from "./templateScope";

/**
 * Classifies where the cursor sits inside an active `{{...}}` expression.
 *
 * - `path`: a plain value position - either the top-level expression (no
 *   enclosing call) or the interior of a call argument. Both `namespace.path`
 *   lookups and function names are valid here. This is the historical default
 *   and preserves the pre-function behavior exactly for expressions with no
 *   parentheses.
 * - `function-callee`: reserved for future use where the cursor is known to be
 *   on a callee token. Not currently emitted by {@link detectTrigger}; value
 *   positions are reported as `path` so both namespaces and functions can be
 *   offered by the scope registry.
 * - `argument`: the cursor is inside a function call's parentheses. The `path`
 *   and `prefix` describe the argument sub-expression under the cursor, and
 *   `functionName`/`argumentIndex` identify the enclosing call.
 */
export type TriggerKind = "path" | "function-callee" | "argument";

/**
 * Result of trigger detection - describes the autocomplete context.
 */
export interface TriggerContext {
  /** Whether an unclosed `{{` was found before the cursor */
  active: boolean;
  /** The kind of cursor context inside the active expression */
  kind: TriggerKind;
  /** The resolved path segments (e.g. ["steps", "fetch"]) */
  path: string[];
  /** The text typed after the last `.` (the current filter prefix) */
  prefix: string;
  /** Character offset of the `{{` trigger in the field text (-1 if inactive) */
  triggerOffset: number;
  /** When `kind === "argument"`, the name of the enclosing function call */
  functionName?: string;
  /** When `kind === "argument"`, the zero-based index of the argument under the cursor */
  argumentIndex?: number;
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
    kind: "path",
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

  // Classify the cursor context by tokenizing the expression region: track
  // parenthesis depth and the boundaries of the current call/argument so a
  // function-call expression resolves its argument interior correctly while a
  // plain path expression (no parens) behaves exactly as before.
  const scope = scanExpressionScope(content);

  // The current sub-expression is the text of the argument (or top-level
  // expression) under the cursor. Resolve it with the historical dot-split so
  // path/prefix semantics are identical to the pre-function behavior.
  const { path, prefix } = resolvePathPrefix(scope.subExpression);

  if (scope.functionName === undefined) {
    // Depth-0, not inside any call: a plain value/path position (unchanged).
    return {
      active: true,
      kind: "path",
      path,
      prefix,
      triggerOffset,
    };
  }

  // Inside a function call's parentheses: an argument sub-expression.
  return {
    active: true,
    kind: "argument",
    path,
    prefix,
    triggerOffset,
    functionName: scope.functionName,
    argumentIndex: scope.argumentIndex,
  };
}

/**
 * Describes the innermost call context at the cursor within an expression.
 */
interface ExpressionScope {
  /** Text of the current sub-expression under the cursor (argument or top-level). */
  subExpression: string;
  /** Name of the enclosing function call, or undefined at the top level (depth 0). */
  functionName?: string;
  /** Zero-based index of the argument under the cursor within the enclosing call. */
  argumentIndex: number;
}

/**
 * Scans expression text (the content between `{{` and the cursor) to find the
 * innermost call context: the enclosing function name (if any), the argument
 * index under the cursor, and the raw text of the current sub-expression.
 *
 * This is a deliberately small tokenizer (not a full parser): it tracks
 * parenthesis depth and comma boundaries to mirror the tolerant grammar used by
 * the backend evaluator/validator. Expressions with no parentheses yield a
 * top-level scope whose sub-expression is the entire content, preserving the
 * historical dot-path behavior byte-for-byte.
 *
 * @param content - Expression text from just after `{{` up to the cursor
 * @returns The innermost call context at the cursor
 */
function scanExpressionScope(content: string): ExpressionScope {
  // Stack of open calls: each frame records where its current argument starts
  // and the callee name that immediately preceded its `(`.
  const stack: Array<{ argStart: number; argIndex: number; functionName?: string }> = [];
  let segmentStart = 0; // start of the current top-level or argument sub-expression

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "(") {
      // The callee is the identifier immediately preceding this `(`.
      const preceding = content.slice(segmentStart, i);
      const functionName = extractTrailingIdentifier(preceding);
      stack.push({ argStart: i + 1, argIndex: 0, functionName });
      segmentStart = i + 1;
    } else if (ch === ")") {
      if (stack.length > 0) {
        stack.pop();
        // Resume the parent segment after this closed call.
        segmentStart = i + 1;
      }
    } else if (ch === "," && stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      frame.argIndex += 1;
      frame.argStart = i + 1;
      segmentStart = i + 1;
    }
  }

  if (stack.length === 0) {
    return { subExpression: content.slice(segmentStart), argumentIndex: 0 };
  }

  const top = stack[stack.length - 1]!;
  return {
    subExpression: content.slice(top.argStart),
    functionName: top.functionName,
    argumentIndex: top.argIndex,
  };
}

/**
 * Extracts a trailing identifier (function callee) from text preceding a `(`.
 * Ignores surrounding whitespace. Returns undefined when no identifier is found
 * (e.g. a parenthesized sub-expression like `(a.b)` with no callee).
 *
 * @param text - Text immediately before an open parenthesis
 * @returns The trailing identifier, or undefined when none is present
 */
function extractTrailingIdentifier(text: string): string | undefined {
  const match = text.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*$/);
  return match ? match[1] : undefined;
}

/**
 * Splits a sub-expression into resolved `path` segments and the trailing
 * `prefix` (the text after the last `.`), matching the historical behavior of
 * {@link detectTrigger}. Leading whitespace within the sub-expression (e.g.
 * after a `(` or `,`) is trimmed so `fn( image.da` resolves `image` as a path
 * segment rather than ` image`.
 *
 * @param subExpression - The current sub-expression text under the cursor
 * @returns The resolved path segments and current prefix
 */
function resolvePathPrefix(subExpression: string): { path: string[]; prefix: string } {
  const trimmed = subExpression.replace(/^\s+/, "");
  const segments = trimmed.split(".");
  const prefix = segments[segments.length - 1] ?? "";
  const path = segments.slice(0, -1);
  return { path, prefix };
}

/**
 * Counts the number of parentheses left open between the `{{` trigger and the
 * cursor, i.e. how many `)` are still needed to balance the expression. Used so
 * that completing a terminal value inside a function call closes the open call
 * before appending the `}}`, rather than closing the braces prematurely.
 *
 * @param text - Current field text
 * @param triggerOffset - Offset of the `{{` trigger in the text
 * @param cursorPos - Current cursor position
 * @returns The count of unclosed `(` at the cursor (never negative)
 */
function countOpenParens(text: string, triggerOffset: number, cursorPos: number): number {
  const region = text.slice(triggerOffset + 2, cursorPos);
  let depth = 0;
  for (const ch of region) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
  }
  return depth;
}

/**
 * Computes the text insertion for an accepted suggestion.
 *
 * For terminal suggestions: replaces the typed prefix with label, closes any
 * still-open function-call parentheses, then appends `}}`.
 * For non-terminal suggestions: replaces the typed prefix with label + `.`
 * For function suggestions: replaces the typed prefix with label + `(`.
 *
 * @param text - Current field text
 * @param cursorPos - Current cursor position
 * @param triggerOffset - Offset of the `{{` trigger (used to balance open parens)
 * @param suggestion - The accepted suggestion
 * @param _path - Current resolved path segments (kept for API symmetry)
 * @param prefix - Current typed prefix being replaced
 * @returns InsertionResult with new text and cursor position
 */
export function computeInsertion(
  text: string,
  cursorPos: number,
  triggerOffset: number,
  suggestion: Suggestion,
  _path: string[],
  prefix: string,
): InsertionResult {
  const prefixStart = cursorPos - prefix.length;

  // Determine how much of the current segment remains after the cursor.
  // When the cursor is mid-word (e.g. "filen|ame"), we need to consume
  // the trailing part of the segment so it gets replaced entirely.
  // Only consume identifier-like characters (alphanumeric, hyphens, underscores)
  // that are part of the same expression segment.
  const afterCursor = text.slice(cursorPos);
  const segmentEndMatch = afterCursor.match(/^[a-zA-Z0-9_-]*/);
  const segmentTail = segmentEndMatch ? segmentEndMatch[0].length : 0;

  if (suggestion.kind === "function") {
    // Function: replace the typed callee prefix with `name(` and keep the popup
    // open with the cursor placed inside the parentheses, ready for arguments.
    const inserted = `${suggestion.label}(`;
    // If the author already typed an open paren right after the callee, do not
    // duplicate it.
    let skipAfter = segmentTail;
    if (text[cursorPos + segmentTail] === "(") {
      skipAfter += 1;
    }
    const after = text.slice(cursorPos + skipAfter);
    const newText = text.slice(0, prefixStart) + inserted + after;
    const newCursorPos = prefixStart + inserted.length;
    return { newText, newCursorPos, keepOpen: true };
  }

  if (suggestion.terminal) {
    // Terminal: replace the current segment with the label, close any still-open
    // function-call parentheses, then append the `}}`. This prevents completing
    // a value inside a call (e.g. `base64Decode(trigger.payload`) from closing
    // the braces before the call is closed.
    let skipAfter = segmentTail;

    // Number of `)` needed to balance the open function call(s) at the cursor.
    const parensToClose = countOpenParens(text, triggerOffset, cursorPos);

    // Consume any `)` the author already typed after the cursor (up to the
    // number we need), so the closers we insert are not duplicated. We still
    // emit `parensToClose` closers below - consuming here only repositions them
    // to sit before the `}}` rather than leaving a stray `)` afterward.
    let consumedClosers = 0;
    while (consumedClosers < parensToClose && text[cursorPos + skipAfter] === ")") {
      skipAfter += 1;
      consumedClosers += 1;
    }

    // Skip a `}}` immediately following, to avoid duplication.
    if (text.slice(cursorPos + skipAfter, cursorPos + skipAfter + 2) === "}}") {
      skipAfter += 2;
    }

    const inserted = `${suggestion.label}${")".repeat(parensToClose)}}}`;
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
