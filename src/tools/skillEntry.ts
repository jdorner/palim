/**
 * Skill entry type.
 *
 * Self-contained (no `@src`/`@shared` imports) so it can be re-exported
 * through the extension public API (`@ext/types`) without dragging the
 * sandbox module's runtime dependencies (just-bash, config, command
 * builder) into an extension's type-resolution graph.
 *
 * @module
 */

/** A discovered skill entry with its physical location and metadata. */
export interface SkillEntry {
  /** Skill name from frontmatter. */
  name: string;
  /** Absolute path to the skill directory (parent of SKILL.md). */
  directory: string;
  /** Parsed YAML frontmatter from SKILL.md. */
  frontmatter: { name: string; description: string; [key: string]: unknown };
  /** Name of the extension that owns this skill. */
  extensionName: string;
  /** Program names registered by this skill's scripts. */
  programNames: string[];
}
