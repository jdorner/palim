#!/usr/bin/env -S bun --eval
import { join } from "node:path";
import { createInterface } from "node:readline";
import { styleText } from "node:util";
import { EXTENSIONS_DIR, EXTERNAL_EXTENSIONS_DIR, WORK_DIR } from "@src/config";
import { discoverSkills, loadSkillScripts } from "@src/skills/loader";
import { createShell } from "@src/tools/sandbox";
import type { Bash } from "just-bash";

const SANDBOX_HOME = "/home/user" as const;
const SANDBOX_WORK = join(SANDBOX_HOME, "work");

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
      process.stderr.write(`Error: ${err}\n`);
    }

    rl.setPrompt(makePrompt());
    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nBye!");
    process.exit(0);
  });

  rl.prompt();
}

// --- Main ---
async function main(): Promise<void> {
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
