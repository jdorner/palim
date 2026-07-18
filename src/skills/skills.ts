import type { SkillEntry } from "@src/tools/sandbox";

/** Options for building skill context strings. */
type SkillReadOptions = {
  /** Function to resolve a skill name to its entry. */
  resolveSkill: (name: string) => SkillEntry | undefined;
  /** Skill names to include in the output. */
  includeSkills: string[];
};

/**
 * Formats skill frontmatter entries into the XML context block used by agent system prompts.
 *
 * @param frontmatterEntries - Parsed skill frontmatter objects
 * @returns XML string containing filtered skill data with frontmatter and metadata
 */
function formatSkillsXml(
  frontmatterEntries: Array<{ name: string; description: string; [key: string]: unknown }>,
): string {
  return `<available_skills>\n${frontmatterEntries
    .map((fm) => {
      const lines = [`<name>${escapeXml(fm.name)}</name>`, `<description>${escapeXml(fm.description)}</description>`];
      return `<skill>\n${lines.join("\n")}\n</skill>`;
    })
    .join("\n")}\n</available_skills>`;
}

/**
 * Builds an `<available_skills>` XML context string from a skill
 * and list of skill names. Only reads frontmatter (no file I/O).
 *
 * Used by queue factories that need synchronous buildProcessor callbacks.
 *
 * @param options - Configuration with skill resolver and include list
 * @returns XML string containing filtered skill frontmatter
 */
export function getSkillsForContext(options: SkillReadOptions): string {
  const entries = options.includeSkills
    .map((name) => options.resolveSkill(name))
    .filter((entry): entry is SkillEntry => !!entry);

  return formatSkillsXml(entries.map((e) => e.frontmatter));
}

/**
 * Escapes special XML characters in a string.
 *
 * @param value - String to escape
 * @returns Escaped string safe for XML
 */
function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}
