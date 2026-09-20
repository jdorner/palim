#!/usr/bin/env bun

/**
 * Builds the container image and publishes it to a container registry
 * (e.g. the Gitea package registry).
 *
 * The image is tagged with the version from package.json plus a "latest" tag.
 * Configuration is read from environment variables (or a .env file, which Bun
 * loads automatically), with command-line flags taking precedence:
 *
 *   REGISTRY_HOST   Registry host, optionally with port (e.g. gitea.example.com:3000)
 *   REGISTRY_OWNER  Owner namespace: a Gitea user or organization
 *   REGISTRY_IMAGE  Image name
 *   REGISTRY_USER   Login username (optional; enables `login` before push)
 *   REGISTRY_TOKEN  Login token/password with write:package scope (optional)
 *   CONTAINER_ENGINE  "docker" or "podman" (default: docker)
 *
 * Flags: --host, --owner, --image, --user, --token, --engine,
 *        --tag <extra tag> (repeatable), --no-latest, --no-push, --dry-run
 *
 * Run with:
 *   bun run publish --host gitea.example.com --owner <owner> --user <user> --token <token>
 */

import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dirname, "..");

interface PublishConfig {
  host: string;
  owner: string;
  image: string;
  version: string;
  engine: string;
  user?: string;
  token?: string;
  extraTags: string[];
  includeLatest: boolean;
  push: boolean;
  dryRun: boolean;
}

/**
 * Reads a flag value from the parsed argument map, falling back to an
 * environment variable and then a default.
 *
 * @param flags - Parsed command-line flags
 * @param flagName - The flag key to look up (without leading dashes)
 * @param envName - The environment variable name to fall back to
 * @param fallback - Default value when neither flag nor env var is set
 * @returns The resolved string value
 */
function resolveValue(flags: Map<string, string[]>, flagName: string, envName: string, fallback = ""): string {
  const flagValues = flags.get(flagName);
  if (flagValues && flagValues.length > 0 && flagValues[0]) {
    return flagValues[0];
  }
  return process.env[envName]?.trim() || fallback;
}

/**
 * Parses process.argv into a map of flag name to values.
 *
 * Supports repeated flags (e.g. multiple `--tag`), `--flag value` and
 * boolean flags (`--no-push`) which are stored with an empty-string value.
 *
 * @param argv - Raw argument list (typically `process.argv.slice(2)`)
 * @returns Map of flag names to their collected values
 */
function parseFlags(argv: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    const isBoolean = next === undefined || next.startsWith("--");
    const value = isBoolean ? "" : next;
    if (!isBoolean) i++;
    const existing = flags.get(name) ?? [];
    existing.push(value);
    flags.set(name, existing);
  }
  return flags;
}

/**
 * Reads the `version` field from the project's package.json.
 *
 * @returns The version string
 * @throws If package.json cannot be read or has no version
 */
async function readVersion(): Promise<string> {
  const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { version?: string };
  if (!pkg.version) {
    throw new Error("No version field found in package.json");
  }
  return pkg.version;
}

/**
 * Builds the full publish configuration from flags, env vars, and package.json.
 *
 * @param argv - Raw argument list
 * @returns The resolved publish configuration
 * @throws If required values (host, owner) are missing
 */
async function buildConfig(argv: string[]): Promise<PublishConfig> {
  const flags = parseFlags(argv);

  const host = resolveValue(flags, "host", "REGISTRY_HOST");
  const owner = resolveValue(flags, "owner", "REGISTRY_OWNER");
  const image = resolveValue(flags, "image", "REGISTRY_IMAGE");
  const engine = resolveValue(flags, "engine", "CONTAINER_ENGINE", "docker");
  const user = resolveValue(flags, "user", "REGISTRY_USER") || undefined;
  const token = resolveValue(flags, "token", "REGISTRY_TOKEN") || undefined;

  const missing: string[] = [];
  if (!host) missing.push("host (--host or REGISTRY_HOST)");
  if (!owner) missing.push("owner (--owner or REGISTRY_OWNER)");
  if (!image) missing.push("image (--image or REGISTRY_IMAGE)");
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(", ")}`);
  }

  return {
    host,
    owner,
    image,
    version: await readVersion(),
    engine,
    user,
    token,
    extraTags: flags.get("tag") ?? [],
    includeLatest: !flags.has("no-latest"),
    push: !flags.has("no-push"),
    dryRun: flags.has("dry-run"),
  };
}

/**
 * Assembles the full list of image references to build and push.
 *
 * @param config - The resolved publish configuration
 * @returns Fully-qualified image references (host/owner/image:tag)
 */
function buildImageRefs(config: PublishConfig): string[] {
  const base = `${config.host}/${config.owner}/${config.image}`;
  const tags = [config.version, ...config.extraTags];
  if (config.includeLatest) tags.push("latest");
  const unique = [...new Set(tags)].filter((tag) => tag.length > 0);
  return unique.map((tag) => `${base}:${tag}`);
}

/**
 * Runs a container-engine command, echoing it first. Honors dry-run mode.
 *
 * @param config - The resolved publish configuration
 * @param args - Arguments passed to the container engine
 * @throws If the command exits with a non-zero code
 */
async function runEngine(config: PublishConfig, args: string[]): Promise<void> {
  print(`  $ ${config.engine} ${args.join(" ")}`);
  if (config.dryRun) return;

  const result = await $`${config.engine} ${args}`.cwd(ROOT).nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`${config.engine} ${args[0]} failed with exit code ${result.exitCode}`);
  }
}

/**
 * Logs in to the registry, piping the token via stdin so it never appears in
 * the process argument list.
 *
 * @param config - The resolved publish configuration (must have user and token)
 * @throws If the login command exits with a non-zero code
 */
async function loginToRegistry(config: PublishConfig): Promise<void> {
  const { engine, host, user, token } = config;
  print(`  $ ${engine} login ${host} -u ${user} --password-stdin`);
  if (config.dryRun) return;

  const result = await $`${engine} login ${host} -u ${user} --password-stdin < ${new Response(token)}`
    .cwd(ROOT)
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`${engine} login failed with exit code ${result.exitCode}`);
  }
}

function print(msg: string): void {
  console.log(msg);
}

function blank(): void {
  console.log();
}

async function main(): Promise<void> {
  const config = await buildConfig(process.argv.slice(2));
  const refs = buildImageRefs(config);

  blank();
  print("Palim container publish");
  print(`  engine:  ${config.engine}`);
  print(`  version: ${config.version}`);
  print("  tags:");
  for (const ref of refs) print(`    - ${ref}`);
  if (config.dryRun) print("  (dry run - no commands will execute)");
  blank();

  // Step 1: Build with all tags applied in a single build.
  print("Building image...");
  const buildArgs = ["build"];
  for (const ref of refs) buildArgs.push("-t", ref);
  buildArgs.push(".");
  await runEngine(config, buildArgs);
  blank();

  if (!config.push) {
    print("Skipping push (--no-push).");
    return;
  }

  // Step 2: Optional login when credentials are provided.
  if (config.user && config.token) {
    print(`Logging in to ${config.host} as ${config.user}...`);
    await loginToRegistry(config);
  } else if (config.user || config.token) {
    print("  ! Both REGISTRY_USER and REGISTRY_TOKEN are required to auto-login; skipping login.");
    print("    Assuming you are already logged in.");
  }
  blank();

  // Step 3: Push each tag.
  print("Pushing image...");
  for (const ref of refs) {
    await runEngine(config, ["push", ref]);
  }
  blank();

  print("Done.");
}

main().catch((err) => {
  console.error(`\nPublish failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
