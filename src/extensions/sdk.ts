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

export type { OutputSchema, OutputSchemaShorthand, OutputSchemaShorthandValue } from "../../shared/workflows";
// NOTE: imports here use RELATIVE paths into the core tree rather than the
// `@src/*` alias. `@ext/sdk` maps to this real file, so an external extension
// type-checking against it must resolve every re-exported module. Relative
// paths resolve against the real filesystem regardless of the consumer's
// tsconfig, keeping `@ext/sdk` resolvable with only the `@ext/*` aliases
// (mirrors the approach in ./publicTypes for `@ext/types`). The modules in
// this closure are correspondingly kept free of `@src`/`@shared` imports.
export { parseSkillMd } from "../skills/frontmatter";
export { getSkillsForContext } from "../skills/skills";
export type { CreateShellOptions } from "../tools/sandbox";
export { createShell, registerProgram } from "../tools/sandbox";
export type { SkillEntry } from "../tools/skillEntry";
export type { ArgDef, CommandDef, OptionDef, SubcommandDef } from "../utils/command";
export { createCommand, formatFetchError, formatHttpError, ParsedArgs } from "../utils/command";
export { FileWatcher } from "../utils/fileWatcher";
export type { JsonValidationFailure, JsonValidationResult, JsonValidationSuccess } from "../utils/json";
export { extractJson, validateJsonInput, validateJsonOutput } from "../utils/json";
export type { JsonSchemaValidationError, JsonSchemaValidationResult } from "../utils/jsonSchema";
export { validateJsonSchema } from "../utils/jsonSchema";
export { formatValidationErrors } from "../utils/validation";
export { compileOutputSchema } from "./core/workflows/outputSchemaCompiler";
export type { SkillScriptContext } from "./types";
