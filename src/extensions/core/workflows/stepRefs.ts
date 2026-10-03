/**
 * Hyphenated step slugs inside template expressions.
 *
 * Step slugs may contain hyphens (`fetch-mails`, `step-13`). In a plain
 * dot-path template (`{{steps.fetch-mails.result}}`) that is unambiguous, but
 * once an expression uses function-call syntax it is parsed as JavaScript-like
 * code, where `steps.fetch-mails.result` reads as `steps.fetch - mails.result`.
 *
 * Since the workflow's slugs are known, `steps.<slug>` occurrences naming a
 * known hyphenated slug can be located lexically (the longest known slug wins)
 * and either rewritten to bracket notation for evaluation or extracted as a
 * path reference for validation. A genuine subtraction such as `steps.a - b`
 * is only misread when a step is literally named `a-b`.
 */

/** A located `steps.<slug>[.<path>]` reference naming a known hyphenated slug. */
export interface HyphenatedStepRef {
  /** Offset of the `s` of `steps`. */
  start: number;
  /** Offset just past the slug. */
  slugEnd: number;
  /** Offset just past the trailing dot-path (equals `slugEnd` when there is none). */
  pathEnd: number;
  /** The referenced slug. */
  slug: string;
}

/** Matches string literals, so references inside them are left alone. */
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** Matches `steps.` followed by a hyphen-capable segment, not preceded by an identifier char or `.`. */
const STEP_SEGMENT = /(?<![A-Za-z0-9_$.])steps\.([A-Za-z0-9_$][A-Za-z0-9_$-]*)/g;

/** Matches a trailing `.<segment>` dot-path chain. */
const TRAILING_PATH = /^(?:\.[A-Za-z0-9_$]+)*/;

/**
 * Locates `steps.<slug>` references whose slug is a known hyphenated slug.
 *
 * @param expr - The expression text (without braces)
 * @param slugs - The workflow's step slugs
 * @returns The located references, in order of appearance
 */
export function findHyphenatedStepRefs(expr: string, slugs: Iterable<string>): HyphenatedStepRef[] {
  const hyphenated = new Set([...slugs].filter((s) => s.includes("-")));
  if (hyphenated.size === 0 || !expr.includes("-")) return [];

  // Blank out string literals (same length) so offsets stay valid.
  const masked = expr.replace(STRING_LITERAL, (m) => " ".repeat(m.length));

  const refs: HyphenatedStepRef[] = [];
  STEP_SEGMENT.lastIndex = 0;
  for (let m = STEP_SEGMENT.exec(masked); m !== null; m = STEP_SEGMENT.exec(masked)) {
    const parts = m[1]!.split("-");
    for (let n = parts.length; n >= 2; n--) {
      const slug = parts.slice(0, n).join("-");
      if (!hyphenated.has(slug)) continue;
      const slugEnd = m.index + "steps.".length + slug.length;
      const pathEnd = slugEnd + TRAILING_PATH.exec(masked.slice(slugEnd))![0].length;
      refs.push({ start: m.index, slugEnd, pathEnd, slug });
      STEP_SEGMENT.lastIndex = slugEnd;
      break;
    }
  }
  return refs;
}

/**
 * Rewrites `steps.<hyphenated-slug>` to `steps["<hyphenated-slug>"]` so the
 * expression evaluator does not parse the hyphen as subtraction.
 *
 * @param expr - The expression text (without braces)
 * @param slugs - The workflow's step slugs
 * @returns The rewritten expression (unchanged when nothing matched)
 */
export function quoteHyphenatedStepRefs(expr: string, slugs: Iterable<string>): string {
  const refs = findHyphenatedStepRefs(expr, slugs);
  if (refs.length === 0) return expr;
  let out = "";
  let last = 0;
  for (const ref of refs) {
    out += `${expr.slice(last, ref.start)}steps[${JSON.stringify(ref.slug)}]`;
    last = ref.slugEnd;
  }
  return out + expr.slice(last);
}
