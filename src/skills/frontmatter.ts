import { parse as parseYaml } from "yaml";

/** Result of parsing a SKILL.md file into frontmatter and body content. */
export interface ParsedSkill {
  frontmatter: Record<string, unknown>;
  content: string;
  error: boolean;
  errorMessage?: string;
}

/** Regex that captures the YAML block between `---` fences and the remaining body. */
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

/**
 * Parses a SKILL.md file, extracting YAML frontmatter and markdown body.
 *
 * Uses the `yaml` package for frontmatter parsing so values containing
 * colons, quoted strings, arrays, and nested objects are handled correctly.
 *
 * @param fileContent - Raw file content with `---` delimited frontmatter
 * @returns Parsed frontmatter and trimmed body content. Check the `error`
 *          flag to determine if parsing succeeded.
 */
export function parseSkillMd(fileContent: string): ParsedSkill {
  const match = fileContent.match(FRONTMATTER_REGEX);

  if (!match) {
    return { frontmatter: {}, content: "", error: true, errorMessage: "No frontmatter fences found" };
  }

  const [, frontmatterText, content] = match;

  if (!frontmatterText) {
    return { frontmatter: {}, content: content?.trim() || "", error: false };
  }

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(frontmatterText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { frontmatter: {}, content: content?.trim() || "", error: true, errorMessage: message };
  }

  // parseYaml can return null/undefined for empty documents or scalar values
  if (frontmatter == null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return { frontmatter: {}, content: content?.trim() || "", error: false };
  }

  return {
    frontmatter: frontmatter as Record<string, unknown>,
    content: content?.trim() || "",
    error: false,
  };
}
