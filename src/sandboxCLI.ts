#!/usr/bin/env -S bun --eval
import { join } from "node:path";
import { createInterface } from "node:readline";
import { styleText } from "node:util";
import { EXTENSIONS_DIR, EXTERNAL_EXTENSIONS_DIR, serverOrigin, WORK_DIR } from "@src/config";
import { discoverSkills, loadSkillScripts } from "@src/skills/loader";
import { createShell } from "@src/tools/sandbox";
import { setSystemToken } from "@src/utils/fetch";
import type { Bash } from "just-bash";

const SANDBOX_HOME = "/home/user" as const;
const SANDBOX_WORK = join(SANDBOX_HOME, "work");

// --- Login ---

/** Bearer token of the logged-in user, empty when running unauthenticated. */
let authToken = "";

/**
 * Prompts for a line of input on the terminal.
 *
 * @param question - The prompt text.
 * @returns The entered line.
 */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompts for a password without echoing the typed characters.
 *
 * @param question - The prompt text.
 * @returns The entered password.
 * @throws When the prompt is aborted with Ctrl+C or Ctrl+D.
 */
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let input = "";
    const finish = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(input);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") return finish(new Error("Login aborted"));
        if (ch === "\u007f" || ch === "\b") input = input.slice(0, -1);
        else input += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Logs in against the running Palim server so sandbox programs that call the
 * internal API (e.g. `datatable`) authorize as that user.
 *
 * Credentials come from `PALIM_USER` / `PALIM_PASSWORD` when set, otherwise
 * they are prompted for interactively. The resulting token is installed as the
 * process-wide fallback token, which skill script fetches resolve to when no
 * per-job identity is in scope. Failures are reported and the CLI continues
 * unauthenticated.
 */
async function login(): Promise<void> {
  const origin = serverOrigin();
  const interactive = process.stdin.isTTY;

  let username = process.env.PALIM_USER ?? "";
  let password = process.env.PALIM_PASSWORD ?? "";
  if (!interactive && (!username || !password)) {
    console.error(styleText("yellow", "No TTY and PALIM_USER/PALIM_PASSWORD not set; continuing unauthenticated."));
    return;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (!username) username = await ask(`Palim user (${origin}): `);
    if (!password) password = await askHidden("Password: ");

    let resp: Response;
    try {
      resp = await fetch(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
    } catch (err) {
      console.error(
        styleText("yellow", `Palim server not reachable at ${origin} (${err}); continuing unauthenticated.`),
      );
      return;
    }

    if (resp.ok) {
      const { token, user } = (await resp.json()) as { token: string; user: { username?: string } };
      authToken = token;
      setSystemToken(token);
      console.log(styleText("green", `Logged in as ${user.username ?? username}.`));
      return;
    }

    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    console.error(styleText("red", `Login failed: ${body.error ?? resp.statusText}`));
    if (resp.status === 429 || !interactive) break;
    password = "";
    if (!process.env.PALIM_USER) username = "";
  }
  console.error(styleText("yellow", "Continuing unauthenticated."));
}

/** Revokes the CLI's login token on the server (best-effort). */
async function logout(): Promise<void> {
  if (!authToken) return;
  try {
    await fetch(`${serverOrigin()}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
  } catch {
    // Server gone; the token expires on its own.
  }
}

// --- PWD tracking ---
let lastPwd = SANDBOX_WORK;

function makePrompt(): string {
  return `${styleText("green", "sandbox")} ${lastPwd || SANDBOX_WORK} $ `;
}

async function runInteractive(shell: Bash): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: makePrompt(),
  });

  rl.on("line", async (input) => {
    const line = input.trim();
    rl.pause();

    try {
      const result = await shell.exec(line, { cwd: lastPwd });

      if (result.stdout) {
        process.stdout.write(result.stdout);
        if (!result.stdout.endsWith("\n")) process.stdout.write("\n");
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
        if (!result.stderr.endsWith("\n")) process.stderr.write("\n");
      }

      lastPwd = result.env.PWD || lastPwd;
    } catch (err) {
      process.stderr.write(`${err}\n`);
    }

    rl.setPrompt(makePrompt());
    rl.resume();
    rl.prompt();
  });

  rl.on("close", async () => {
    await logout();
    console.log("\nBye!");
    process.exit(0);
  });

  rl.prompt();
}

// --- Main ---
async function main(): Promise<void> {
  await login();

  const skillMap = await discoverSkills([EXTENSIONS_DIR, EXTERNAL_EXTENSIONS_DIR]);
  await loadSkillScripts(skillMap, EXTENSIONS_DIR);

  const shell = await createShell({
    skills: [...skillMap.keys()],
    resolveSkill: (name) => skillMap.get(name),
    workDir: WORK_DIR,
  });

  runInteractive(shell);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
