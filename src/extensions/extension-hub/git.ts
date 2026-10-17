/**
 * Thin wrapper around the git CLI.
 *
 * Every invocation runs non-interactively (no credential or host-key prompts),
 * with a timeout, and restricted to the file, git, http(s), and ssh transports
 * (`ext::` and other helper transports could run arbitrary commands). An HTTPS
 * token is passed through `GIT_CONFIG_*` environment variables, so it never
 * appears in the process arguments or in error messages.
 *
 * @module
 */

import { HubError } from "./errors";

/** Default timeout for local git commands. */
export const GIT_TIMEOUT_MS = 30_000;

/** Timeout for commands that talk to the remote (clone, fetch). */
export const GIT_NETWORK_TIMEOUT_MS = 120_000;

/** Extension folder / package names the hub accepts. */
export const EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Characters allowed in tag and branch names (a conservative subset of git's rules). */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/;

/** A full or abbreviated commit SHA. */
export const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;

/** Options for {@link runGit}. */
export interface GitOptions {
  /** Repository directory (`git -C`). */
  cwd?: string;
  /** Timeout in ms (default {@link GIT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** HTTPS access token for the remote (sent as basic auth header). */
  token?: string | null;
  /** Data written to stdin. */
  stdin?: string;
}

/**
 * Validates a tag or branch name supplied by a caller.
 *
 * @param ref - The ref name
 * @returns The ref
 * @throws {HubError} 400 when the name is unsafe or malformed
 */
export function assertSafeRef(ref: string): string {
  if (!REF_PATTERN.test(ref) || ref.includes("..") || ref.endsWith(".lock") || ref.endsWith("/")) {
    throw new HubError(400, `Invalid ref "${ref}"`);
  }
  return ref;
}

/**
 * Validates a git remote URL: ssh, https, http, git, file URLs, scp-style
 * `user@host:path`, or an absolute local path.
 *
 * Credentials embedded in the URL are refused: the URL is shown to every
 * operator and written into installed trees, so tokens belong in the source's
 * token field. Only ssh URLs may carry a user name (no password).
 *
 * @param url - The remote URL
 * @returns The trimmed URL
 * @throws {HubError} 400 when the URL is not accepted
 */
export function assertSafeRemoteUrl(url: string): string {
  const value = url.trim();
  const isSchemeUrl = /^(ssh|https?|git|file):\/\/[^\s]+$/.test(value);
  const ok = isSchemeUrl || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value) || /^\/[^\s]*$/.test(value);
  if (!ok || value.startsWith("-") || value.length > 500) {
    throw new HubError(400, `Unsupported repository URL "${value}"`);
  }
  if (isSchemeUrl) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new HubError(400, "Unsupported repository URL: it could not be parsed");
    }
    if (parsed.password || (parsed.username && parsed.protocol !== "ssh:")) {
      throw new HubError(
        400,
        "Repository URLs must not contain credentials; enter an access token in the token field instead",
      );
    }
  }
  return value;
}

/**
 * Returns the part of a validated remote URL a token is bound to: scheme,
 * host, and port. Local paths and `file://` URLs share one origin.
 *
 * @param url - A URL accepted by {@link assertSafeRemoteUrl}
 * @returns A comparable origin string
 */
export function remoteOrigin(url: string): string {
  if (url.startsWith("/") || url.startsWith("file://")) return "file:";
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):/.exec(url);
  if (scp && !url.includes("://")) return `ssh://${scp[1]!.toLowerCase()}`;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

/**
 * Builds the environment for a git process.
 *
 * @param token - Optional HTTPS access token
 * @returns The environment variables
 */
export function gitEnv(token?: string | null): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
    LC_ALL: "C",
  };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return env;
}

/**
 * Spawns git and returns the raw process (for streaming output).
 *
 * @param args - git arguments (without `git`)
 * @param options - Working directory, token, timeout
 * @returns The spawned process and a function clearing its timeout
 */
export function spawnGit(
  args: string[],
  options: GitOptions = {},
): { proc: Bun.Subprocess<"pipe", "pipe", "pipe">; clear: () => void } {
  const cmd = options.cwd ? ["git", "-C", options.cwd, ...args] : ["git", ...args];
  const proc = Bun.spawn(cmd, {
    env: gitEnv(options.token),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? GIT_TIMEOUT_MS);
  return { proc, clear: () => clearTimeout(timer) };
}

/**
 * Runs a git command and returns its stdout.
 *
 * @param args - git arguments (without `git`)
 * @param options - Working directory, token, stdin, timeout
 * @returns stdout as text
 * @throws {HubError} 502 when git exits non-zero or times out
 */
export async function runGit(args: string[], options: GitOptions = {}): Promise<string> {
  const { proc, clear } = spawnGit(args, options);
  try {
    if (options.stdin !== undefined) proc.stdin.write(options.stdin);
    await proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const reason = proc.signalCode ? `timed out (${proc.signalCode})` : stderr.trim() || `exit code ${code}`;
      throw new HubError(502, `git ${args[0]} failed: ${reason}`);
    }
    return stdout;
  } finally {
    clear();
  }
}

/**
 * Runs a git command whose non-zero exit means "no" rather than an error
 * (e.g. `rev-parse --verify --quiet`).
 *
 * @param args - git arguments (without `git`)
 * @param options - Working directory, token, timeout
 * @returns stdout, or null when git exited non-zero
 */
export async function tryGit(args: string[], options: GitOptions = {}): Promise<string | null> {
  try {
    return await runGit(args, options);
  } catch (err) {
    if (err instanceof HubError) return null;
    throw err;
  }
}
