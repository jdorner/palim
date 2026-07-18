#!/usr/bin/env bun

/**
 * Interactive setup script for Palim.
 *
 * Guides a new user through first-time configuration:
 * 1. Copies .env.example to .env (if not present)
 * 2. Prompts for LLM endpoint URL (with validation) and API key
 * 3. Fetches available models from the endpoint and lets the user pick one
 * 4. Generates a master key for the secret vault
 * 5. Installs frontend dependencies and builds the frontend
 *
 * Run with: bun run setup
 */

import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { $ } from "bun";

const ROOT = join(import.meta.dirname, "..");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const ENV_TARGET = join(ROOT, ".env");
const FRONTEND_DIR = join(ROOT, "frontend");

// --- Helpers -----------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

function print(msg: string): void {
  console.log(msg);
}

function blank(): void {
  console.log();
}

function prompt(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function fileExists(path: string): boolean {
  return Bun.file(path).size > 0;
}

/**
 * Validates that a string is a well-formed HTTP(S) URL.
 *
 * @param value - The URL string to validate
 * @returns `true` if valid, `false` otherwise
 */
function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Fetches model IDs from an OpenAI-compatible `/models` endpoint.
 *
 * @param baseUrl - The base URL (e.g. `http://localhost:11434/v1`)
 * @returns Array of model IDs, or empty array on failure
 */
async function fetchModels(baseUrl: string): Promise<string[]> {
  try {
    const url = `${baseUrl}/models`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];

    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((entry) => entry.id);
  } catch {
    return [];
  }
}

/**
 * Parses a .env file and returns a key-value map.
 *
 * @param path - Path to the .env file
 * @returns Map of environment variable names to their values
 */
async function parseEnvFile(path: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  try {
    const content = await Bun.file(path).text();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      entries.set(key, value);
    }
  } catch {
    // File unreadable - return empty map
  }
  return entries;
}

// --- Steps -------------------------------------------------------------------

async function copyEnvFile(): Promise<boolean> {
  if (fileExists(ENV_TARGET)) {
    print(`  ✓ ${basename(ENV_TARGET)} already exists - skipping copy.`);
    return false;
  }

  const source = Bun.file(ENV_EXAMPLE);
  if (!(await source.exists())) {
    print(`  ✗ ${basename(ENV_EXAMPLE)} not found. Cannot create env file.`);
    process.exit(1);
  }

  await Bun.write(ENV_TARGET, source);
  print(`  ✓ Created ${basename(ENV_TARGET)} from ${basename(ENV_EXAMPLE)}`);
  return true;
}

/**
 * Prompts for and validates the LLM base URL.
 * Loops until a valid URL is entered.
 *
 * @param currentValue - Existing value to use as default
 * @returns The validated URL string
 */
async function promptBaseUrl(currentValue?: string): Promise<string> {
  const defaultUrl = currentValue || "http://localhost:11434/v1";
  while (true) {
    const value = await prompt("    LLM endpoint URL (OpenAI-compatible /v1 base)", defaultUrl);
    if (isValidUrl(value)) {
      return value;
    }
    print("    ✗ Invalid URL. Please enter a valid http:// or https:// URL.");
  }
}

/**
 * Fetches available models from the endpoint and lets the user select one.
 * Falls back to manual entry if the endpoint is unreachable.
 *
 * @param baseUrl - The validated LLM base URL
 * @param currentModel - The currently configured model (used as fallback default)
 * @returns The selected model ID
 */
async function promptModelSelection(baseUrl: string, currentModel?: string): Promise<string> {
  print("    Checking available models...");
  const models = await fetchModels(baseUrl);

  if (models.length === 0) {
    print("    ⚠ Could not reach endpoint or no models found.");
    return await prompt("    Enter model name manually", currentModel || "llama3");
  }

  blank();
  print("    Available models:");
  // Determine which index to pre-select based on current model
  let defaultIndex = 1;
  for (let i = 0; i < models.length; i++) {
    const marker = models[i] === currentModel ? " (current)" : "";
    print(`      ${i + 1}) ${models[i]}${marker}`);
    if (models[i] === currentModel) {
      defaultIndex = i + 1;
    }
  }
  blank();

  while (true) {
    const choice = await prompt(`    Select model (1–${models.length})`, String(defaultIndex));
    const index = Number.parseInt(choice, 10) - 1;
    if (index >= 0 && index < models.length) {
      return models[index]!;
    }
    print(`    ✗ Please enter a number between 1 and ${models.length}.`);
  }
}

/**
 * Prompts for all LLM configuration values.
 *
 * @param currentValues - Existing env values to use as defaults
 * @returns The configured LLM settings
 */
async function promptLlmConfig(
  currentValues?: Map<string, string>,
): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  print("  Configure your LLM connection:");
  blank();

  const currentUrl = currentValues?.get("OPENAI_API_BASE_URL");
  const currentKey = currentValues?.get("OPENAI_API_KEY");
  const currentModel = currentValues?.get("OPENAI_DEFAULT_MODEL");

  const baseUrl = await promptBaseUrl(currentUrl);
  const apiKey = await prompt("    API key", currentKey || "sk-no-key");
  blank();
  const model = await promptModelSelection(baseUrl, currentModel);

  return { baseUrl, apiKey, model };
}

async function writeEnvValues(values: { baseUrl: string; apiKey: string; model: string }): Promise<void> {
  const content = await Bun.file(ENV_TARGET).text();

  let updated = content;
  updated = updated.replace(/^OPENAI_API_BASE_URL=.*$/m, `OPENAI_API_BASE_URL=${values.baseUrl}`);
  updated = updated.replace(/^OPENAI_API_KEY=.*$/m, `OPENAI_API_KEY=${values.apiKey}`);
  updated = updated.replace(/^OPENAI_DEFAULT_MODEL=.*$/m, `OPENAI_DEFAULT_MODEL=${values.model}`);

  await Bun.write(ENV_TARGET, updated);
  print(`  ✓ LLM settings written to ${basename(ENV_TARGET)}`);
}

/**
 * Generates a SECRETS_MASTER_KEY if not already set in .env.
 *
 * Uses Web Crypto to produce a cryptographically random 32-byte hex string.
 * Skips generation if the key already has a value.
 */
async function ensureSecretsMasterKey(): Promise<void> {
  const content = await Bun.file(ENV_TARGET).text();
  const match = content.match(/^SECRETS_MASTER_KEY=(.*)$/m);
  const currentValue = match?.[1]?.trim() ?? "";

  if (currentValue) {
    print("  ✓ SECRETS_MASTER_KEY already configured - skipping.");
    return;
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Buffer.from(bytes).toString("hex");

  const updated = content.replace(/^SECRETS_MASTER_KEY=.*$/m, `SECRETS_MASTER_KEY=${hex}`);
  await Bun.write(ENV_TARGET, updated);
  print("  ✓ Generated SECRETS_MASTER_KEY (32 bytes, hex)");
}

async function buildFrontend(): Promise<void> {
  print("  Installing frontend dependencies...");
  const install = await $`bun install`.cwd(FRONTEND_DIR).quiet();
  if (install.exitCode !== 0) {
    print("  ✗ Frontend install failed:");
    print(install.stderr.toString());
    process.exit(1);
  }
  print("  ✓ Frontend dependencies installed");

  print("  Building frontend...");
  const build = await $`bun run build`.cwd(FRONTEND_DIR).quiet();
  if (build.exitCode !== 0) {
    print("  ✗ Frontend build failed:");
    print(build.stderr.toString());
    process.exit(1);
  }
  print("  ✓ Frontend built successfully");
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  blank();
  print("╭──────────────────────────────────────╮");
  print("│    🔔 Palim! - First-time setup      │");
  print("╰──────────────────────────────────────╯");
  blank();

  // Step 1: Copy env file
  print("① Environment file");
  const freshCopy = await copyEnvFile();
  blank();

  // Step 2: LLM configuration
  print("② LLM configuration");
  const currentEnv = await parseEnvFile(ENV_TARGET);

  if (freshCopy) {
    const llmConfig = await promptLlmConfig(currentEnv);
    blank();
    await writeEnvValues(llmConfig);
  } else {
    const reconfigure = await prompt("    .env already exists. Reconfigure LLM settings? (y/N)", "n");
    if (reconfigure.toLowerCase() === "y") {
      const llmConfig = await promptLlmConfig(currentEnv);
      blank();
      await writeEnvValues(llmConfig);
    } else {
      print("  -> Keeping existing LLM configuration.");
    }
  }
  blank();

  // Step 3: Secret vault key
  print("③ Secret Vault");
  await ensureSecretsMasterKey();
  blank();

  // Step 4: Build frontend
  print("④ Frontend build");
  await buildFrontend();
  blank();

  // Done
  rl.close();
  blank();
  print("╭──────────────────────────────────────╮");
  print("│        🔔 Setup complete!            │");
  print("│                                      │");
  print("│   Start Palim with: bun run dev      │");
  print("╰──────────────────────────────────────╯");
  blank();
}

main().catch((err) => {
  rl.close();
  console.error("Setup failed:", err);
  process.exit(1);
});
