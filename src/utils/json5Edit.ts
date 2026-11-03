/**
 * Text-preserving edits of a JSON5 document's top-level object members.
 *
 * Rewriting a JSON5 file through `JSON.stringify` drops its comments and
 * formatting. These helpers locate a top-level member in the source text and
 * replace, insert, or remove just that member, leaving everything else intact.
 *
 * @module
 */

/** Location of one top-level member in the source text. */
interface MemberSpan {
  key: string;
  /** Whether the key was written as a double-quoted string. */
  quotedKey: boolean;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  /** Index just past the member's trailing comma, or `null` without one. */
  commaEnd: number | null;
}

const IDENT_CHAR = /[\p{L}\p{N}_$‌‍]/u;

/** Index past any whitespace and comments starting at `i`, or `-1` on an unterminated block comment. */
function skipTrivia(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c) || c === "﻿") {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 2;
    } else {
      break;
    }
  }
  return i;
}

/** Index just past the string literal opening at `i`, or `-1` if unterminated. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === quote) return i + 1;
    else i++;
  }
  return -1;
}

/** Index just past the value starting at `i`, or `-1` if it is malformed. */
function skipValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"' || c === "'") return skipString(text, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"' || ch === "'") {
        i = skipString(text, i);
        if (i === -1) return -1;
        continue;
      }
      if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
        i = skipTrivia(text, i);
        if (i === -1) return -1;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }
  // Scalar: number, true/false/null, Infinity, NaN.
  const start = i;
  while (i < text.length && !/[\s,}\]/]/.test(text[i]!)) i++;
  return i > start ? i : -1;
}

/** Lists the members of the document's root object, or returns `null` if it cannot be scanned. */
function scanRootMembers(text: string): MemberSpan[] | null {
  let i = skipTrivia(text, 0);
  if (i === -1 || text[i] !== "{") return null;
  i++;
  const members: MemberSpan[] = [];
  for (;;) {
    i = skipTrivia(text, i);
    if (i === -1 || i >= text.length) return null;
    if (text[i] === "}") return members;

    const keyStart = i;
    let key: string;
    let quotedKey = false;
    if (text[i] === '"' || text[i] === "'") {
      const end = skipString(text, i);
      if (end === -1) return null;
      quotedKey = text[i] === '"';
      try {
        key = Bun.JSON5.parse(text.slice(i, end)) as string;
      } catch {
        return null;
      }
      i = end;
    } else {
      while (i < text.length && IDENT_CHAR.test(text[i]!)) i++;
      if (i === keyStart) return null;
      key = text.slice(keyStart, i);
    }

    i = skipTrivia(text, i);
    if (i === -1 || text[i] !== ":") return null;
    const valueStart = skipTrivia(text, i + 1);
    if (valueStart === -1) return null;
    const valueEnd = skipValue(text, valueStart);
    if (valueEnd === -1) return null;

    i = skipTrivia(text, valueEnd);
    if (i === -1) return null;
    let commaEnd: number | null = null;
    if (text[i] === ",") {
      commaEnd = i + 1;
      i++;
    } else if (text[i] !== "}") {
      return null;
    }
    members.push({ key, quotedKey, keyStart, valueStart, valueEnd, commaEnd });
  }
}

/** Start of the line containing `i`. */
function lineStart(text: string, i: number): number {
  const nl = Math.max(text.lastIndexOf("\n", i - 1), text.lastIndexOf("\r", i - 1));
  return nl + 1;
}

/**
 * End of the "tail" after `i`: the line break ending the line if only
 * whitespace and a line comment follow, otherwise `null`.
 */
function restOfLineEnd(text: string, i: number): number | null {
  let j = i;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
  if (text[j] === "/" && text[j + 1] === "/") {
    while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
  }
  if (j >= text.length || text[j] === "\n" || text[j] === "\r") return j;
  return null;
}

/** Index just past the line break at `i` (handles `\r\n`). */
function pastLineBreak(text: string, i: number): number {
  if (text[i] === "\r" && text[i + 1] === "\n") return i + 2;
  return i < text.length ? i + 1 : i;
}

/**
 * Sets or removes a top-level member of a JSON5 object document while keeping
 * the rest of the text (comments, formatting, key order) unchanged.
 *
 * A new member is inserted on its own line after the last member named in
 * `insertAfter` that exists, else as the first member. The result is verified
 * by parsing it and comparing with the expected object.
 *
 * @param text - JSON5 source whose root is an object
 * @param key - Top-level key to set or remove
 * @param value - JSON-serializable value, or `undefined` to remove the member
 * @param insertAfter - Preferred preceding keys for a newly inserted member, in priority order
 * @returns The edited text, or `null` if the text could not be edited safely
 */
export function setTopLevelJson5Property(
  text: string,
  key: string,
  value: unknown,
  insertAfter: string[] = [],
): string | null {
  let original: unknown;
  try {
    original = Bun.JSON5.parse(text);
  } catch {
    return null;
  }
  if (!original || typeof original !== "object" || Array.isArray(original)) return null;
  const members = scanRootMembers(text);
  if (!members) return null;

  const expected: Record<string, unknown> = { ...(original as Record<string, unknown>) };
  if (value === undefined) delete expected[key];
  else expected[key] = value;

  const edited = applyEdit(text, members, key, value, insertAfter);
  if (edited === null) return null;
  try {
    return Bun.deepEquals(Bun.JSON5.parse(edited), expected) ? edited : null;
  } catch {
    return null;
  }
}

/** Builds the edited text for {@link setTopLevelJson5Property}; unverified. */
function applyEdit(
  text: string,
  members: MemberSpan[],
  key: string,
  value: unknown,
  insertAfter: string[],
): string | null {
  // Duplicate keys: JSON5 keeps the last one, so drop or edit all of them.
  const matching = members.filter((m) => m.key === key);
  const serialized = value === undefined ? "" : JSON.stringify(value);
  if (value !== undefined && serialized === undefined) return null;

  if (value !== undefined && matching.length > 0) {
    const last = matching[matching.length - 1]!;
    return text.slice(0, last.valueStart) + serialized + text.slice(last.valueEnd);
  }

  if (value === undefined) {
    let out = text;
    // Remove from the back so earlier indexes stay valid.
    for (const m of [...matching].reverse()) {
      const end = m.commaEnd ?? m.valueEnd;
      const start = lineStart(out, m.keyStart);
      const ownLine = /^[ \t]*$/.test(out.slice(start, m.keyStart));
      const eol = restOfLineEnd(out, end);
      if (ownLine && eol !== null) {
        out = out.slice(0, start) + out.slice(pastLineBreak(out, eol));
      } else {
        let stop = end;
        while (stop < out.length && (out[stop] === " " || out[stop] === "\t")) stop++;
        out = out.slice(0, m.keyStart) + out.slice(stop);
      }
    }
    return out;
  }

  // Insert a new member.
  const eolStyle = text.includes("\r\n") ? "\r\n" : "\n";
  let anchor: MemberSpan | undefined;
  for (const name of insertAfter) {
    anchor = members.findLast((m) => m.key === name);
    if (anchor) break;
  }
  const reference = anchor ?? members[0];
  const keyText = reference?.quotedKey ? JSON.stringify(key) : key;

  if (!reference) {
    // Empty root object.
    const open = text.indexOf("{");
    return `${text.slice(0, open + 1)} ${keyText}: ${serialized} ${text.slice(open + 1)}`;
  }

  const refLineStart = lineStart(text, reference.keyStart);
  const indentMatch = /^[ \t]*/.exec(text.slice(refLineStart, reference.keyStart));
  const onOwnLine = indentMatch !== null && indentMatch[0].length === reference.keyStart - refLineStart;

  if (!anchor) {
    // Before the first member.
    if (onOwnLine) {
      return `${text.slice(0, refLineStart)}${indentMatch[0]}${keyText}: ${serialized},${eolStyle}${text.slice(refLineStart)}`;
    }
    return `${text.slice(0, reference.keyStart)}${keyText}: ${serialized}, ${text.slice(reference.keyStart)}`;
  }

  const afterAnchor = anchor.commaEnd ?? anchor.valueEnd;
  const eol = restOfLineEnd(text, afterAnchor);
  const comma = anchor.commaEnd === null ? "," : "";
  if (onOwnLine && eol !== null) {
    // `comma` must follow the anchor's value, before any trailing comment.
    const head = text.slice(0, afterAnchor) + comma + text.slice(afterAnchor, eol);
    const trailingComma = anchor.commaEnd === null ? "" : ",";
    return `${head}${eolStyle}${indentMatch[0]}${keyText}: ${serialized}${trailingComma}${text.slice(eol)}`;
  }
  const trailingComma = anchor.commaEnd === null ? "" : ",";
  return `${text.slice(0, afterAnchor)}${comma} ${keyText}: ${serialized}${trailingComma}${text.slice(afterAnchor)}`;
}
