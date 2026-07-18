import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { serverOrigin, WORK_DIR } from "@src/config";
import { parseSkillMd } from "@src/skills/frontmatter";
import { createCommand, formatHttpError } from "@src/utils/command";
import {
  Bash,
  type CommandContext,
  defineCommand,
  type ExecResult,
  InMemoryFs,
  MountableFs,
  OverlayFs,
  ReadWriteFs,
} from "just-bash";

const SANDBOX_HOME_DIR = "/home/user" as const;
const SANDBOX_SKILLS_DIR = "/skills" as const;

/** A registered shell program entry. */
interface ProgramEntry {
  name: string;
  callback: (args: string[], ctx: CommandContext) => Promise<ExecResult>;
}

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

/** Module-level registry of programs keyed by skill name. */
const programRegistry = new Map<string, ProgramEntry[]>();

/**
 * Registers a program associated with a specific skill. Only shells
 * created with that skill in their skill list will have this program.
 *
 * @param name - Program name (bare name or absolute path)
 * @param callback - The program handler
 * @param skillName - The skill this program belongs to
 */
export function registerProgram(
  name: string,
  callback: (args: string[], ctx: CommandContext) => Promise<ExecResult>,
  skillName: string,
): void {
  let entries = programRegistry.get(skillName);
  if (!entries) {
    entries = [];
    programRegistry.set(skillName, entries);
  }
  entries.push({ name, callback });
}

/**
 * Resolves a skill name to its virtual SKILL.md path inside the sandbox,
 * rejecting traversal attempts.
 *
 * @param name - The skill name from user input
 * @returns The resolved virtual path to the skill's SKILL.md
 * @throws {Error} If the resolved path escapes the skills directory
 */
function resolveSkillPath(name: string): string {
  const resolved = resolve(SANDBOX_SKILLS_DIR, name, "SKILL.md");
  if (!resolved.startsWith(`${SANDBOX_SKILLS_DIR}`)) {
    throw new Error("Invalid skill name: path traversal detected.");
  }
  return resolved;
}

/**
 * Registers core built-in programs onto a shell instance.
 * The `skill` command operates on the shell's virtual filesystem so it
 * only sees skills that have been mounted for this shell.
 *
 * @param sh - The shell to register programs on
 */
function registerCorePrograms(sh: Bash): void {
  const ReadSkillSchema = Type.Object({
    name: Type.String({ minLength: 1, description: "Skill name to read" }),
  });

  // Disabled for now
  // const WriteSkillSchema = Type.Object({
  //   name: Type.String({ minLength: 1, description: "Skill name to create or update" }),
  // });

  const shellFs = sh.fs;

  sh.registerCommand(
    defineCommand(
      "skill",
      createCommand({
        name: "skill",
        description: "Manage agent skills.",
        subcommands: [
          {
            name: "read",
            description: "Read a skill's SKILL.md contents",
            schema: ReadSkillSchema,
            handler: async (_ctx, args) => {
              const { name } = args.validated<{ name: string }>()!;

              let skillPath: string;
              try {
                skillPath = resolveSkillPath(name);
              } catch {
                return { exitCode: 1, stdout: "", stderr: "Error: Invalid skill name." };
              }

              try {
                const content = await shellFs.readFile(skillPath);
                return { exitCode: 0, stdout: content, stderr: "" };
              } catch {
                return { exitCode: 1, stdout: "", stderr: `Skill '${name}' not found.` };
              }
            },
          },
          // Disabled for now
          // {
          //   name: "write",
          //   description: "Create or update a skill's SKILL.md (content via stdin)",
          //   schema: WriteSkillSchema,
          //   handler: async (ctx, args) => {
          //     const { name } = args.validated<{ name: string }>()!;
          //     const content = decodeBytesToUtf8(ctx.stdin).trim();

          //     if (!content) {
          //       return { exitCode: 1, stdout: "", stderr: "Error: No content provided. Pipe content via stdin." };
          //     }

          //     let skillPath: string;
          //     try {
          //       skillPath = resolveSkillPath(name);
          //     } catch {
          //       return { exitCode: 1, stdout: "", stderr: "Error: Invalid skill name." };
          //     }

          //     try {
          //       await shellFs.writeFile(skillPath, content);
          //       return { exitCode: 0, stdout: `Skill '${name}/SKILL.md' written successfully.`, stderr: "" };
          //     } catch (err) {
          //       return { exitCode: 1, stdout: "", stderr: `Failed to write skill: ${err}` };
          //     }
          //   },
          // },
          {
            name: "list",
            description: "List all available skills",
            handler: async () => {
              try {
                const entries = await shellFs.readdir(SANDBOX_SKILLS_DIR);
                const skills: Array<{ name: string; description: string }> = [];

                for (const entry of entries) {
                  const skillMdPath = join(SANDBOX_SKILLS_DIR, entry, "SKILL.md");
                  try {
                    const content = await shellFs.readFile(skillMdPath);
                    const parsed = parseSkillMd(content);
                    if (
                      !parsed.error &&
                      typeof parsed.frontmatter.name === "string" &&
                      typeof parsed.frontmatter.description === "string"
                    ) {
                      skills.push({
                        name: parsed.frontmatter.name,
                        description: parsed.frontmatter.description,
                      });
                    }
                  } catch {
                    // Skip entries without a valid SKILL.md
                  }
                }

                if (skills.length === 0) {
                  return { exitCode: 0, stdout: "No skills found.", stderr: "" };
                }

                skills.sort((a, b) => a.name.localeCompare(b.name));
                const maxName = Math.max(...skills.map((s) => s.name.length));
                const lines = skills.map((s) => {
                  const padded = s.name.padEnd(maxName + 2);
                  return `  ${padded}${s.description}`;
                });

                return { exitCode: 0, stdout: `Skills:\n${lines.join("\n")}`, stderr: "" };
              } catch (err) {
                return { exitCode: 1, stdout: "", stderr: `Failed to list skills: ${err}` };
              }
            },
          },
        ],
      }),
    ),
  );
}

/**
 * Builds the `push` program handler for sending content to the chat UI
 * via the push endpoint.
 *
 * Usage:
 * ```
 * push "Hello from the script"
 * push --type text/plain "Raw output"
 * ```
 *
 * Reads `PALIM_PUSH_URL` and `PALIM_SESSION_ID` from the shell environment.
 * Includes an `Authorization: Bearer` header when `AUTH_TOKEN` is set in process.env.
 *
 * @returns A command handler suitable for `defineCommand()`
 */
export function buildPushCommand(): (args: string[], ctx: CommandContext) => Promise<ExecResult> {
  return async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const pushUrl = ctx.env.get("PALIM_PUSH_URL");
    const sessionId = ctx.env.get("PALIM_SESSION_ID");

    if (!pushUrl || !sessionId) {
      return { exitCode: 1, stdout: "", stderr: "Error: PALIM_PUSH_URL and PALIM_SESSION_ID must be set" };
    }

    // Parse args: optional --type <contentType>, then content string
    let contentType = "text/markdown";
    let content: string | undefined;
    let i = 0;

    while (i < args.length) {
      const token = args[i]!;
      if (token === "--type" || token === "-t") {
        const typeVal = args[i + 1];
        if (!typeVal) {
          return { exitCode: 1, stdout: "", stderr: "Error: --type requires a value" };
        }
        contentType = typeVal;
        i += 2;
      } else {
        content = token;
        i++;
      }
    }

    if (!content) {
      return { exitCode: 1, stdout: "", stderr: "Error: missing content argument" };
    }

    const body = JSON.stringify({ sessionId, content, contentType });
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    // Include auth token if configured
    if (process.env.AUTH_TOKEN) {
      headers.Authorization = `Bearer ${process.env.AUTH_TOKEN}`;
    }

    try {
      const resp = await fetch(pushUrl, { method: "POST", headers, body });

      if (resp.ok) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      return await formatHttpError(resp);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, stdout: "", stderr: `Error: ${message}` };
    }
  };
}

/** Options for creating a scoped shell instance. */
export interface CreateShellOptions {
  /** Skill names to mount in this shell. Only these skills' programs will be available. */
  skills: string[];
  /** Resolves a skill name to its {@link SkillEntry}, or undefined if not found. */
  resolveSkill: (name: string) => SkillEntry | undefined;
  /**
   * Override the host work directory mounted into the sandbox.
   * Defaults to the global `WORK_DIR` from config when not specified.
   * Useful for tests and REPL sessions that need isolated workspaces.
   */
  workDir?: string;
  /** Optional session ID to set in the shell's environment. */
  sessionId?: string;
}

/**
 * Creates a new, fully-configured {@link Bash} instance scoped to the
 * requested skills.
 *
 * Each instance has its own isolated environment with the work directory
 * mounted and only the requested skills' directories and programs available.
 *
 * @param options - Shell configuration with skill list and resolver
 * @returns A fresh, ready-to-use Bash instance
 */
export async function createShell(options: CreateShellOptions): Promise<Bash> {
  const agentWorkDir = join(SANDBOX_HOME_DIR, "work");

  const hostWorkDir = options.workDir ?? WORK_DIR;

  const basefs = new InMemoryFs();
  basefs.mkdirSync("/tmp", { recursive: true });

  const fs = new MountableFs({ base: basefs });
  fs.mount(agentWorkDir, new ReadWriteFs({ root: hostWorkDir }));

  // Resolve all skills upfront (fail-fast on missing skills)
  const resolvedSkills = options.skills.map((name) => {
    const skill = options.resolveSkill(name);
    if (!skill) {
      throw new Error(`Skill "${name}" not found in registry`);
    }
    return { name, skill };
  });

  // Mount each skill's directory into the virtual filesystem
  for (const { name, skill } of resolvedSkills) {
    fs.mount(join(SANDBOX_SKILLS_DIR, name), new OverlayFs({ root: skill.directory, readOnly: true, mountPoint: "/" }));
  }

  const sh = new Bash({
    fs,
    cwd: agentWorkDir,
    env: {
      HOME: SANDBOX_HOME_DIR,
      ...(options.sessionId
        ? {
            PALIM_SESSION_ID: options.sessionId,
            PALIM_PUSH_URL: `${serverOrigin()}/api/push`,
          }
        : {}),
    },
  });

  registerCorePrograms(sh);

  // Register the `push` built-in program when a session ID is configured
  if (options.sessionId) {
    sh.registerCommand(defineCommand("push", buildPushCommand()));
  }

  // Register programs belonging to the requested skills
  for (const { name } of resolvedSkills) {
    const entries = programRegistry.get(name);
    if (entries) {
      for (const entry of entries) {
        sh.registerCommand(defineCommand(entry.name, entry.callback));
      }
    }
  }

  return sh;
}
