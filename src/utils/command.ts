import type { TObject, TProperties, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CommandContext, ExecResult } from "just-bash";
import { isLLMConnectionError } from "./error";
import { formatValidationErrors } from "./validation";

/**
 * Defines a positional argument for a subcommand.
 */
export interface ArgDef {
  /** Argument name shown in usage text. */
  name: string;
  /** Whether this argument is required. Defaults to true. */
  required?: boolean;
  /** Description shown in help text. */
  description?: string;
}

/**
 * Defines a named option for a subcommand (e.g. `--header`, `--timeout`).
 */
export interface OptionDef {
  /** Long option name without dashes (e.g. "header" for `--header`). */
  name: string;
  /** Optional single-character short alias (e.g. "H" for `-H`). */
  short?: string;
  /** Description shown in help text. */
  description?: string;
  /**
   * Whether this option is a boolean flag (no value expected).
   * Defaults to false (option expects a value argument).
   */
  boolean?: boolean;
  /**
   * Whether this option can be specified multiple times.
   * When true, all values are collected into an array.
   * Defaults to false.
   */
  multiple?: boolean;
  /** Default value when the option is not provided. */
  defaultValue?: string;
  /** Whether this option is required. Defaults to false. */
  required?: boolean;
}

/**
 * Result of parsing named options from a raw args array.
 */
interface ParsedOptions {
  /** Map of option name -> value(s). Boolean flags get "true". Multiple options get joined with \0. */
  values: Map<string, string>;
  /** Remaining positional args after options are extracted. */
  positional: string[];
}

/**
 * Parsed arguments accessor. Wraps the parsed positional args and named options,
 * providing type-safe access. Values are guaranteed to exist for required args
 * since validation runs before the handler.
 */
export class ParsedArgs {
  readonly #data: Map<string, string>;
  readonly #options: Map<string, string>;
  readonly #validated: Record<string, unknown> | undefined;

  constructor(entries: [string, string][], validated?: Record<string, unknown>, options?: Map<string, string>) {
    this.#data = new Map(entries);
    this.#options = options ?? new Map();
    this.#validated = validated;
  }

  /**
   * Get a raw string argument value by name (positional args).
   *
   * @param name - The argument name as defined in ArgDef
   * @returns The argument value (empty string for missing optional args)
   */
  get(name: string): string {
    return this.#data.get(name) ?? "";
  }

  /**
   * Get a named option value.
   *
   * @param name - The option name as defined in OptionDef
   * @returns The option value, or empty string if not provided
   */
  option(name: string): string {
    return this.#options.get(name) ?? "";
  }

  /**
   * Get all values for a repeatable option.
   *
   * @param name - The option name as defined in OptionDef (must have `multiple: true`)
   * @returns Array of values (empty array if not provided)
   */
  options(name: string): string[] {
    const raw = this.#options.get(name);
    if (!raw) return [];
    return raw.split("\0");
  }

  /**
   * Get a boolean flag value.
   *
   * @param name - The option name as defined in OptionDef (must have `boolean: true`)
   * @returns true if the flag was set, false otherwise
   */
  flag(name: string): boolean {
    return this.#options.get(name) === "true";
  }

  /**
   * Get the TypeBox-validated and coerced argument object.
   * Only available when the subcommand defines a `schema`.
   *
   * @returns The validated argument object, or `undefined` if no schema was used
   */
  validated<T = Record<string, unknown>>(): T | undefined {
    return this.#validated as T | undefined;
  }
}

/**
 * Defines a subcommand within a command.
 *
 * Argument validation can use either the simple `args` array or a TypeBox
 * `schema`. When `schema` is provided, positional CLI args are mapped to
 * schema properties (in declaration order), coerced to the declared types,
 * and validated with `Value.Check`. The validated object is accessible via
 * `ParsedArgs.validated()`.
 *
 * Named options (flags and key-value pairs) can be defined via the `options`
 * array. Options are extracted from the raw args before positional parsing,
 * so they can appear anywhere in the argument list.
 */
export interface SubcommandDef {
  /** Subcommand name (e.g. "add", "list"). */
  name: string;
  /** Short description shown in help text. */
  description?: string;
  /** Positional argument definitions, in order. */
  args?: ArgDef[];
  /**
   * Named option definitions (e.g. `--header`, `--timeout`, `-v`).
   * Options are extracted before positional arg parsing.
   */
  options?: OptionDef[];
  /**
   * TypeBox schema for argument validation. Properties are matched to
   * positional args in declaration order. Use `Type.Optional()` for
   * optional args. The `description` field on each property is used
   * for help text generation.
   */
  schema?: TObject<TProperties>;
  /**
   * Handler function. Receives the CommandContext and parsed positional args.
   * @param ctx - The just-bash command context
   * @param args - Parsed positional arguments accessible via `.get(name)`, `.option(name)`, `.flag(name)`, or `.validated()`
   * @returns An ExecResult with exit code, stdout, and stderr
   */
  handler: (ctx: CommandContext, args: ParsedArgs) => Promise<ExecResult>;
}

/**
 * Top-level command definition.
 */
export interface CommandDef {
  /** Program name (e.g. "task", "skill-request"). */
  name: string;
  /** Short description shown in help text. */
  description?: string;
  /** Subcommand definitions. */
  subcommands: SubcommandDef[];
}

/**
 * Extracts ordered property entries from a TypeBox TObject schema.
 * Each entry contains the property name, its schema, and whether it's required.
 *
 * @param schema - The TypeBox object schema
 * @returns Array of `[name, propertySchema, required]` tuples
 */
function schemaProperties(schema: TObject<TProperties>): [string, TSchema, boolean][] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]) => [name, prop as TSchema, required.has(name)]);
}

/**
 * Parses named options from a raw args array, separating them from positional args.
 * Supports `--name value`, `--name=value`, `--flag` (boolean), `-n value`, and `-n=value`.
 * `--` stops option parsing (everything after is positional).
 *
 * @param rawArgs - Raw argument tokens (after subcommand name is removed)
 * @param optionDefs - Option definitions for this subcommand
 * @returns Parsed options map and remaining positional args
 */
function parseOptions(rawArgs: string[], optionDefs: OptionDef[]): ParsedOptions {
  const longMap = new Map<string, OptionDef>();
  const shortMap = new Map<string, OptionDef>();

  for (const opt of optionDefs) {
    longMap.set(opt.name, opt);
    if (opt.short) {
      shortMap.set(opt.short, opt);
    }
  }

  const values = new Map<string, string>();
  const positional: string[] = [];
  let i = 0;

  while (i < rawArgs.length) {
    const token = rawArgs[i]!;

    // `--` stops option parsing
    if (token === "--") {
      i++;
      // Everything remaining is positional
      while (i < rawArgs.length) {
        positional.push(rawArgs[i]!);
        i++;
      }
      break;
    }

    // Long option: --name or --name=value
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name = eqIdx >= 0 ? token.slice(2, eqIdx) : token.slice(2);
      const def = longMap.get(name);

      if (!def) {
        // Unknown option - treat as positional
        positional.push(token);
        i++;
        continue;
      }

      if (def.boolean) {
        setOptionValue(values, def, "true");
        i++;
      } else if (eqIdx >= 0) {
        setOptionValue(values, def, token.slice(eqIdx + 1));
        i++;
      } else {
        // Next token is the value
        const val = rawArgs[i + 1];
        if (val === undefined) {
          // Missing value - store empty to let validation catch it
          setOptionValue(values, def, "");
          i++;
        } else {
          setOptionValue(values, def, val);
          i += 2;
        }
      }
      continue;
    }

    // Short option: -n or -n=value
    if (token.startsWith("-") && token.length >= 2 && token[1] !== "-") {
      const eqIdx = token.indexOf("=");
      const shortName = eqIdx >= 0 ? token.slice(1, eqIdx) : token.slice(1);
      const def = shortMap.get(shortName);

      if (!def) {
        // Unknown short option - treat as positional
        positional.push(token);
        i++;
        continue;
      }

      if (def.boolean) {
        setOptionValue(values, def, "true");
        i++;
      } else if (eqIdx >= 0) {
        setOptionValue(values, def, token.slice(eqIdx + 1));
        i++;
      } else {
        const val = rawArgs[i + 1];
        if (val === undefined) {
          setOptionValue(values, def, "");
          i++;
        } else {
          setOptionValue(values, def, val);
          i += 2;
        }
      }
      continue;
    }

    // Regular positional arg
    positional.push(token);
    i++;
  }

  // Apply defaults for options not provided
  for (const opt of optionDefs) {
    if (!values.has(opt.name) && opt.defaultValue !== undefined) {
      values.set(opt.name, opt.defaultValue);
    }
  }

  return { values, positional };
}

/**
 * Sets an option value, handling multiple/repeatable options by joining with \0.
 *
 * @param values - The options map being built
 * @param def - The option definition
 * @param value - The value to set or append
 */
function setOptionValue(values: Map<string, string>, def: OptionDef, value: string): void {
  if (def.multiple) {
    const existing = values.get(def.name);
    values.set(def.name, existing ? `${existing}\0${value}` : value);
  } else {
    values.set(def.name, value);
  }
}

/**
 * Validates that all required options are present.
 *
 * @param optionDefs - Option definitions for this subcommand
 * @param values - Parsed option values
 * @param programName - Top-level program name (for error messages)
 * @param sub - The subcommand definition (for usage string)
 * @returns null if valid, or an ExecResult error
 */
function validateOptions(
  optionDefs: OptionDef[],
  values: Map<string, string>,
  programName: string,
  sub: SubcommandDef,
): ExecResult | null {
  for (const opt of optionDefs) {
    if (opt.required && !values.has(opt.name)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: Missing required option --${opt.name}\n\nUsage: ${subcommandUsage(programName, sub)}`,
      };
    }
  }
  return null;
}

/**
 * Builds a usage string for a subcommand, supporting both `args` and `schema`.
 * @param programName - The top-level program name
 * @param sub - The subcommand definition
 * @returns Formatted usage string
 */
function subcommandUsage(programName: string, sub: SubcommandDef): string {
  const parts = argPartsForSub(sub);
  const optParts = optionPartsForSub(sub);
  const allParts = [...optParts, ...parts];
  return `${programName} ${sub.name}${allParts.length > 0 ? ` ${allParts.join(" ")}` : ""}`;
}

/**
 * Returns formatted arg placeholders (e.g. `<line>`, `[reason]`) for a subcommand.
 * Works with both `args` and `schema`.
 *
 * @param sub - The subcommand definition
 * @returns Array of formatted placeholder strings
 */
function argPartsForSub(sub: SubcommandDef): string[] {
  if (sub.schema) {
    return schemaProperties(sub.schema).map(([name, , req]) => (req ? `<${name}>` : `[${name}]`));
  }
  return (sub.args ?? []).map((a) => (a.required !== false ? `<${a.name}>` : `[${a.name}]`));
}

/**
 * Returns formatted option placeholders for usage text.
 *
 * @param sub - The subcommand definition
 * @returns Array of formatted option strings (e.g. `[--timeout <ms>]`, `[--verbose]`)
 */
function optionPartsForSub(sub: SubcommandDef): string[] {
  const opts = sub.options ?? [];
  return opts.map((o) => {
    const flag = o.short ? `-${o.short}|--${o.name}` : `--${o.name}`;
    if (o.boolean) {
      return o.required ? flag : `[${flag}]`;
    }
    const withVal = `${flag} <${o.name}>`;
    return o.required ? withVal : `[${withVal}]`;
  });
}

/**
 * Builds the full help text for a command and all its subcommands.
 * @param def - The command definition
 * @returns Formatted help string
 */
function buildHelp(def: CommandDef): string {
  const lines: string[] = [];

  if (def.description) {
    lines.push(def.description, "");
  }

  lines.push(`Usage: ${def.name} <command>`, "");
  lines.push("Commands:");

  const maxLen = Math.max(...def.subcommands.map((s) => s.name.length));
  for (const sub of def.subcommands) {
    const padded = sub.name.padEnd(maxLen + 2);
    lines.push(`  ${padded}${sub.description ?? ""}`);
  }

  lines.push("", `Run '${def.name} <command> --help' for subcommand details.`);
  return lines.join("\n");
}

/**
 * Builds help text for a single subcommand, supporting both `args` and `schema`.
 * @param programName - The top-level program name
 * @param sub - The subcommand definition
 * @returns Formatted subcommand help string
 */
function buildSubcommandHelp(programName: string, sub: SubcommandDef): string {
  const lines: string[] = [];

  if (sub.description) {
    lines.push(sub.description, "");
  }

  lines.push(`Usage: ${subcommandUsage(programName, sub)}`);

  if (sub.schema) {
    const props = schemaProperties(sub.schema);
    if (props.length > 0) {
      lines.push("", "Arguments:");
      const maxLen = Math.max(...props.map(([n]) => n.length));
      for (const [name, prop, req] of props) {
        const tag = req ? "(required)" : "(optional)";
        const desc = (prop as TSchema & { description?: string }).description ?? "";
        const padded = name.padEnd(maxLen + 2);
        lines.push(`  ${padded}${tag}${desc ? `  ${desc}` : ""}`);
      }
    }
  } else {
    const args = sub.args ?? [];
    if (args.length > 0) {
      lines.push("", "Arguments:");
      const maxLen = Math.max(...args.map((a) => a.name.length));
      for (const a of args) {
        const tag = a.required !== false ? "(required)" : "(optional)";
        const padded = a.name.padEnd(maxLen + 2);
        lines.push(`  ${padded}${tag}${a.description ? `  ${a.description}` : ""}`);
      }
    }
  }

  // Options section
  const opts = sub.options ?? [];
  if (opts.length > 0) {
    lines.push("", "Options:");
    const optLabels = opts.map((o) => {
      const shortPart = o.short ? `-${o.short}, ` : "    ";
      return `${shortPart}--${o.name}`;
    });
    const maxLen = Math.max(...optLabels.map((l) => l.length));
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i]!;
      const label = optLabels[i]!.padEnd(maxLen + 2);
      const parts: string[] = [];
      if (opt.description) parts.push(opt.description);
      if (opt.multiple) parts.push("(repeatable)");
      if (opt.required) parts.push("(required)");
      if (opt.defaultValue !== undefined) parts.push(`[default: ${opt.defaultValue}]`);
      lines.push(`  ${label}${parts.join(" ")}`);
    }
  }

  return lines.join("\n");
}

/**
 * Validates positional args against a TypeBox schema.
 * Maps CLI positional args to schema properties in declaration order,
 * runs `Value.Convert` for type coercion, then `Value.Check` for validation.
 *
 * @param sub - The subcommand definition (must have `schema`)
 * @param rawArgs - Raw positional arg strings from the CLI
 * @param programName - Top-level program name (for error messages)
 * @returns The validated object and raw entries, or an `ExecResult` error if validation failed
 */
function validateSchema(
  sub: SubcommandDef,
  rawArgs: string[],
  programName: string,
): { entries: [string, string][]; validated: Record<string, unknown> } | ExecResult {
  const schema = sub.schema!;
  const props = schemaProperties(schema);
  const raw: Record<string, unknown> = {};
  const entries: [string, string][] = [];

  for (let i = 0; i < props.length; i++) {
    const [name, , required] = props[i]!;
    const value = rawArgs[i] ?? "";

    if (!value && required) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: Missing required argument <${name}>\n\nUsage: ${subcommandUsage(programName, sub)}`,
      };
    }

    if (value) {
      raw[name] = value;
    }
    entries.push([name, value]);
  }

  const converted = Value.Convert(schema, raw);

  if (!Value.Check(schema, converted)) {
    const messages = formatValidationErrors(schema, converted);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Validation error: ${messages}\n\nUsage: ${subcommandUsage(programName, sub)}`,
    };
  }

  return { entries, validated: converted as Record<string, unknown> };
}

/**
 * Creates a command handler from a command definition.
 * Handles subcommand routing, argument parsing/validation,
 * and auto-generated help text.
 *
 * Subcommands can define arguments using either the simple `args` array
 * or a TypeBox `schema` for richer validation with type coercion and
 * constraint checking.
 *
 * @param def - The command definition with subcommands
 * @returns A callback suitable for `shell.addProgram()`
 *
 * @example
 * ```ts
 * import { Type } from "@sinclair/typebox";
 *
 * shell.addProgram("task", createCommand({
 *   name: "task",
 *   description: "Manage tasks",
 *   subcommands: [
 *     {
 *       name: "remove",
 *       description: "Remove a task by line number",
 *       schema: Type.Object({
 *         line: Type.Number({ minimum: 1, description: "Line number (1-based)" }),
 *       }),
 *       handler: async (ctx, args) => {
 *         const { line } = args.validated<{ line: number }>()!;
 *         // line is already a number, validated to be >= 1
 *         return 0;
 *       },
 *     },
 *   ],
 * }));
 * ```
 */
export function createCommand(def: CommandDef): (args: string[], ctx: CommandContext) => Promise<ExecResult> {
  const subMap = new Map<string, SubcommandDef>();
  for (const sub of def.subcommands) {
    subMap.set(sub.name, sub);
  }

  return async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    // just-bash passes args WITHOUT the command name - args[0] is the subcommand
    const subName = args[0] ?? "";

    // Top-level help or no subcommand
    if (!subName || subName === "--help" || subName === "-h") {
      return { exitCode: 0, stdout: buildHelp(def), stderr: "" };
    }

    const sub = subMap.get(subName);
    if (!sub) {
      return { exitCode: 1, stdout: "", stderr: `Error: Unknown command "${subName}"\n\n${buildHelp(def)}` };
    }

    // Subcommand help
    if (args[1] === "--help" || args[1] === "-h") {
      return { exitCode: 0, stdout: buildSubcommandHelp(def.name, sub), stderr: "" };
    }

    const rawArgs = args.slice(1);

    // Parse named options first (if any defined)
    const optionDefs = sub.options ?? [];
    let optionValues = new Map<string, string>();
    let positionalArgs = rawArgs;

    if (optionDefs.length > 0) {
      const parsed = parseOptions(rawArgs, optionDefs);
      optionValues = parsed.values;
      positionalArgs = parsed.positional;

      // Validate required options
      const optError = validateOptions(optionDefs, optionValues, def.name, sub);
      if (optError) return optError;
    }

    // Schema-based validation path
    if (sub.schema) {
      const result = validateSchema(sub, positionalArgs, def.name);
      if ("exitCode" in result) return result;
      return sub.handler(ctx, new ParsedArgs(result.entries, result.validated, optionValues));
    }

    // Legacy ArgDef validation path
    const argDefs = sub.args ?? [];
    const entries: [string, string][] = [];

    for (let i = 0; i < argDefs.length; i++) {
      const argDef = argDefs[i]!;
      // For the last arg: join all remaining positionals (supports multi-word queries)
      const isLast = i === argDefs.length - 1;
      const value = isLast && positionalArgs.length > i ? positionalArgs.slice(i).join(" ") : (positionalArgs[i] ?? "");

      if (!value && argDef.required !== false) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error: Missing required argument <${argDef.name}>\n\nUsage: ${subcommandUsage(def.name, sub)}`,
        };
      }

      entries.push([argDef.name, value]);
    }

    return sub.handler(ctx, new ParsedArgs(entries, undefined, optionValues));
  };
}

/**
 * Formats an HTTP error response into an ExecResult with exit code 1.
 * Attempts to parse a JSON `error` field from the response body for a
 * more descriptive message.
 *
 * @param resp - The failed HTTP response
 * @returns ExecResult with exit code 1 and a formatted error in stderr
 */
export async function formatHttpError(resp: Response): Promise<ExecResult> {
  const text = await resp.text();
  let errorMsg = `HTTP ${resp.status}`;
  try {
    const json = JSON.parse(text);
    if (json.error) errorMsg += ` - ${json.error}`;
  } catch {}
  return { exitCode: 1, stdout: "", stderr: `Error: ${errorMsg}` };
}

/**
 * Formats a fetch/network error into a human-readable error string.
 * Recognises common failure modes (connection refused, timeout) and
 * returns a friendlier message.
 *
 * @param error - The caught error
 * @returns Formatted error string prefixed with "Error: "
 */
export function formatFetchError(error: Error): string {
  if (isLLMConnectionError(error.message)) {
    return "Error: Cannot connect to backend server";
  }
  if (error.message.includes("timeout")) {
    return "Error: Connection timeout";
  }
  return `Error: Request failed - ${error.message}`;
}
