#!/usr/bin/env bun

/**
 * Interactive setup script for Palim.
 *
 * Guides a new user through first-time configuration:
 * 1. Copies .env.example to .env (if not present)
 * 2. Prompts for LLM endpoint URL (with validation) and API key
 * 3. Fetches available models from the endpoint and lets the user pick one
 * 4. Generates credentials for the admin account seeded on first boot
 * 5. Generates a master key for the secret vault
 * 6. Installs frontend dependencies and builds the frontend
 *
 * Run with: bun run setup
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { $ } from "bun";

const ROOT = join(import.meta.dirname, "..");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const ENV_TARGET = join(ROOT, ".env");
const FRONTEND_DIR = join(ROOT, "frontend");

/** Reserved username of the built-in system principal (mirrors `SYSTEM_USERNAME`). */
const SYSTEM_USERNAME = "system";
/** Name of the built-in admin role (mirrors `ROLE_ADMIN`). */
const ADMIN_ROLE = "admin";

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

/**
 * Sets a key in the .env file, replacing an existing (possibly commented-out)
 * assignment or appending one when the key is absent.
 *
 * @param key - Environment variable name
 * @param value - Raw value to write (already quoted if needed)
 */
async function setEnvValue(key: string, value: string): Promise<void> {
  const content = await Bun.file(ENV_TARGET).text();
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^#?\\s*${key}=.*$`, "m");
  const updated = pattern.test(content)
    ? content.replace(pattern, () => line)
    : `${content.replace(/\n*$/, "\n")}${line}\n`;
  await Bun.write(ENV_TARGET, updated);
}

/**
 * Resolves the path of the main SQLite database the same way `src/config.ts`
 * does (`DATA_DIR`, else `<AGENT_WORK_DIR>/.palim/`), relative to the project root.
 *
 * @param env - Parsed .env values
 * @returns Absolute path to `palim.db`
 */
function resolveDbPath(env: Map<string, string>): string {
  const expand = (raw: string): string => {
    const home = process.env.HOME;
    const expanded = raw.startsWith("~/") && home ? join(home, raw.slice(2)) : raw;
    return isAbsolute(expanded) ? resolve(expanded) : resolve(ROOT, expanded);
  };
  const dataDir = process.env.DATA_DIR || env.get("DATA_DIR");
  if (dataDir) return join(expand(dataDir), "palim.db");
  const workDir = process.env.AGENT_WORK_DIR || env.get("AGENT_WORK_DIR") || ".work/";
  return join(expand(workDir), ".palim", "palim.db");
}

/** Summary of the human (non-system) user accounts already in the database. */
interface ExistingUsers {
  /** Number of human users. */
  count: number;
  /** Usernames holding the built-in `admin` role. */
  admins: string[];
}

/**
 * Summarizes the human (non-system) user accounts already present in the database.
 *
 * The admin account is only seeded when no such user exists, so a non-zero
 * count means the `AUTH_ADMIN_*` settings no longer have any effect.
 *
 * @param dbPath - Path to `palim.db`
 * @returns User count and admin usernames; zero/empty if the database or tables are absent
 */
function getExistingUsers(dbPath: string): ExistingUsers {
  const none: ExistingUsers = { count: 0, admins: [] };
  if (!fileExists(dbPath)) return none;
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const countRow = db
      .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM users WHERE username != ?")
      .get(SYSTEM_USERNAME);
    const admins = db
      .query<{ username: string }, [string, string]>(
        `SELECT u.username FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         WHERE r.name = ? AND u.username != ?
         ORDER BY u.username`,
      )
      .all(ADMIN_ROLE, SYSTEM_USERNAME)
      .map((row) => row.username);
    return { count: countRow?.count ?? 0, admins };
  } catch {
    // No users table yet (pre-RBAC database) or unreadable - treat as empty
    return none;
  } finally {
    db?.close();
  }
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

/** Admin login details to print once setup has finished. */
interface AdminCredentials {
  /** Username of the admin seeded on first boot. */
  username: string;
  /** Password of the admin seeded on first boot. */
  password: string;
}

/**
 * Strips one pair of surrounding single or double quotes from a .env value.
 *
 * @param value - Raw value as read by {@link parseEnvFile}
 * @returns The unquoted value
 */
function unquote(value: string): string {
  const match = value.match(/^(['"])(.*)\1$/);
  return match ? (match[2] ?? "") : value;
}

/**
 * Ensures credentials for the admin account seeded on first boot
 * (`AUTH_ADMIN_USER` / `AUTH_ADMIN_PASSWORD`) without prompting.
 *
 * Keeps the configured username (default `admin`) and an already configured
 * password; otherwise generates a strong random password and writes it to .env.
 * Skips with a hint when the database already contains users, since the
 * settings are only applied while the users table is empty.
 *
 * @param currentValues - Existing env values
 * @returns Credentials for the final summary, or `undefined` when users already exist
 */
async function ensureAdminCredentials(currentValues: Map<string, string>): Promise<AdminCredentials | undefined> {
  const existingUsers = getExistingUsers(resolveDbPath(currentValues));
  if (existingUsers.count > 0) {
    const admins = existingUsers.admins.length > 0 ? existingUsers.admins.join(", ") : "none";
    print(`  ✓ ${existingUsers.count} user account(s) already exist (admins: ${admins}) - skipping.`);
    print("    AUTH_ADMIN_* only apply on first boot. To regain admin access run:");
    print("      bun run reset-admin [username]");
    return undefined;
  }

  const username = unquote(currentValues.get("AUTH_ADMIN_USER") ?? "") || "admin";
  const currentPassword = unquote(currentValues.get("AUTH_ADMIN_PASSWORD") ?? "");
  if (currentPassword) {
    print(`  ✓ Admin password for "${username}" already configured - keeping it.`);
    return { username, password: currentPassword };
  }

  const password = randomBytes(18).toString("base64url");
  await setEnvValue("AUTH_ADMIN_USER", username);
  await setEnvValue("AUTH_ADMIN_PASSWORD", password);
  print(`  ✓ Generated admin password for "${username}" (credentials shown at the end)`);
  return { username, password };
}

/**
 * Prints the admin credentials after the final banner, so they are not
 * scrolled away by the frontend build output.
 *
 * @param admin - Credentials returned by {@link ensureAdminCredentials}
 */
function printAdminCredentials(admin: AdminCredentials): void {
  print("  Admin login");
  print(`    Username: ${admin.username}`);
  print(`    Password: ${admin.password}`);
  blank();
  print("  ⚠ Log in after first start and change the password from the web UI.");
  blank();
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

  // Step 3: Admin account
  print("③ Admin account");
  const admin = await ensureAdminCredentials(await parseEnvFile(ENV_TARGET));
  blank();

  // Step 4: Secret vault key
  print("④ Secret Vault");
  await ensureSecretsMasterKey();
  blank();

  // Step 5: Build frontend
  print("⑤ Frontend build");
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
  if (admin) printAdminCredentials(admin);
}

main().catch((err) => {
  rl.close();
  console.error("Setup failed:", err);
  process.exit(1);
});
