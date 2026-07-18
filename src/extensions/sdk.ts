/**
 * Extension SDK - stable import surface for skill scripts.
 *
 * Skill scripts import utilities from this module instead of reaching
 * into core internals (`@src/tools/*`, `@src/utils/*`). This barrel
 * re-export ensures that if underlying module paths change, only this
 * file needs updating.
 *
 * @example
 * ```ts
 * import { registerProgram, createCommand } from "../../sdk";
 * ```
 */

export { parseSkillMd } from "@src/skills/frontmatter";
export { getSkillsForContext } from "@src/skills/skills";
export type { SkillEntry } from "@src/tools/sandbox";
export { registerProgram } from "@src/tools/sandbox";
export type { ArgDef, CommandDef, OptionDef, SubcommandDef } from "@src/utils/command";
export { createCommand, formatFetchError, formatHttpError, ParsedArgs } from "@src/utils/command";
export { FileWatcher } from "@src/utils/fileWatcher";
export { formatValidationErrors } from "@src/utils/validation";
export type { SkillScriptContext } from "./types";
