/**
 * Local bare mirrors of extension source repositories.
 *
 * Each source is cloned once into `<DATA_DIR>/extension-hub/repos/<id>.git`
 * and refreshed with `git fetch`. All catalog reads (tags, folders, file
 * contents) run against the mirror, so listing never touches the network.
 * Object reads are cached by `<commit>:<path>`, which is immutable.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { lstat, mkdir, readlink, rm } from "node:fs/promises";
import path from "node:path";
import { HubError } from "./errors";
import { assertTokenAllowed, GIT_NETWORK_TIMEOUT_MS, runGit, spawnGit, tryGit } from "./git";

/** Upper bound of cached object reads per mirror. */
const MAX_CACHE_ENTRIES = 5000;

/** A tag in the mirror. */
export interface TagRef {
  /** Tag name (without `refs/tags/`). */
  name: string;
  /** Commit the tag points to (peeled for annotated tags). */
  commit: string;
}

/**
 * A bare mirror of one source repository.
 */
export class SourceRepo {
  /** Cached `<commit>:<path>` contents (null = missing). */
  private readonly blobCache = new Map<string, string | null>();

  /**
   * @param dir - Mirror directory (`<id>.git`)
   * @param url - Remote URL
   * @param getToken - Resolves the optional HTTPS token for network commands
   */
  constructor(
    readonly dir: string,
    private url: string,
    private readonly getToken: () => Promise<string | null> = async () => null,
  ) {}

  /**
   * Reports whether the mirror has been cloned.
   *
   * @returns True when the bare repository exists
   */
  exists(): boolean {
    return existsSync(path.join(this.dir, "HEAD"));
  }

  /**
   * Changes the remote URL (applied on the next {@link sync}).
   *
   * @param url - The new remote URL
   */
  setUrl(url: string): void {
    this.url = url;
  }

  /**
   * Clones the mirror if needed, then fetches all branches and tags.
   *
   * @throws {HubError} 400 when a token is set on a non-HTTPS URL, 502 when git fails (unreachable remote, auth)
   */
  async sync(): Promise<void> {
    const token = await this.getToken();
    if (token) assertTokenAllowed(this.url);
    if (!this.exists()) {
      await mkdir(path.dirname(this.dir), { recursive: true });
      await rm(this.dir, { recursive: true, force: true });
      try {
        await runGit(["clone", "--bare", "--quiet", "--", this.url, this.dir], {
          token,
          timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        });
      } catch (err) {
        await rm(this.dir, { recursive: true, force: true });
        throw err;
      }
    } else {
      const current = (await tryGit(["remote", "get-url", "origin"], { cwd: this.dir }))?.trim();
      if (current !== this.url) await runGit(["remote", "set-url", "origin", "--", this.url], { cwd: this.dir });
    }
    await runGit(
      ["fetch", "--quiet", "--prune", "--force", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"],
      { cwd: this.dir, token, timeoutMs: GIT_NETWORK_TIMEOUT_MS },
    );
  }

  /**
   * Deletes the mirror from disk.
   */
  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    this.blobCache.clear();
  }

  /**
   * Returns the remote's default branch as recorded at clone time.
   *
   * @returns The branch name, or null when HEAD is detached or unknown
   */
  async defaultBranch(): Promise<string | null> {
    const out = await tryGit(["symbolic-ref", "--short", "HEAD"], { cwd: this.dir });
    return out?.trim() || null;
  }

  /**
   * Lists all tags with the commits they point to.
   *
   * @returns Tags in no particular order
   */
  async listTags(): Promise<TagRef[]> {
    const out = await runGit(
      ["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)", "refs/tags"],
      {
        cwd: this.dir,
      },
    );
    const tags: TagRef[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [name, object, peeled] = line.split("\0");
      if (name && object) tags.push({ name, commit: peeled || object });
    }
    return tags;
  }

  /**
   * Lists all branches with their head commits.
   *
   * @returns Branch name to commit SHA
   */
  async listBranches(): Promise<Map<string, string>> {
    const out = await runGit(["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)", "refs/heads"], {
      cwd: this.dir,
    });
    const branches = new Map<string, string>();
    for (const line of out.split("\n")) {
      const [name, commit] = line.split("\0");
      if (name && commit) branches.set(name, commit);
    }
    return branches;
  }

  /**
   * Resolves a ref (full ref name or SHA) to a commit.
   *
   * @param ref - A validated ref such as `refs/tags/foo@1.0.0` or a SHA
   * @returns The full commit SHA, or null when it does not exist
   */
  async resolveCommit(ref: string): Promise<string | null> {
    const out = await tryGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
      cwd: this.dir,
    });
    return out?.trim() || null;
  }

  /**
   * Lists the top-level folders of a commit.
   *
   * @param commit - Commit SHA
   * @returns Folder names
   */
  async topLevelDirs(commit: string): Promise<string[]> {
    const out = await runGit(["ls-tree", "-d", "--name-only", commit], { cwd: this.dir });
    return out.split("\n").filter(Boolean);
  }

  /**
   * Reads several files at given commits in one git call.
   *
   * @param specs - `<commit>:<path>` object names
   * @returns Spec to file content (null when missing or not a file)
   * @throws {HubError} 502 when git fails or its output is truncated (nothing is cached then)
   */
  async readFiles(specs: string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const missing = [...new Set(specs)].filter((spec) => {
      if (!this.blobCache.has(spec)) return true;
      result.set(spec, this.blobCache.get(spec) ?? null);
      return false;
    });
    if (missing.length === 0) return result;

    const { proc, clear } = spawnGit(["cat-file", "--batch"], { cwd: this.dir });
    try {
      proc.stdin.write(`${missing.join("\n")}\n`);
      await proc.stdin.end();
      const [buffer, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
      const bytes = new Uint8Array(buffer);
      if (code !== 0) throw new HubError(502, `git cat-file failed: exit code ${code}`);
      const decoder = new TextDecoder();
      // A short read must fail the batch: caching the unparsed specs as
      // missing would hide existing files for good (commit specs never change).
      const truncated = () => new HubError(502, "git cat-file returned a truncated batch");
      let offset = 0;
      for (const spec of missing) {
        const eol = bytes.indexOf(0x0a, offset);
        if (eol === -1) throw truncated();
        const header = decoder.decode(bytes.subarray(offset, eol));
        offset = eol + 1;
        const parts = header.split(" ");
        if (parts.length === 3 && /^\d+$/.test(parts[2]!)) {
          const size = Number(parts[2]);
          if (offset + size >= bytes.length || bytes[offset + size] !== 0x0a) throw truncated();
          const content = parts[1] === "blob" ? decoder.decode(bytes.subarray(offset, offset + size)) : null;
          offset += size + 1;
          result.set(spec, content);
        } else {
          result.set(spec, null);
        }
      }
    } finally {
      clear();
    }

    if (this.blobCache.size + missing.length > MAX_CACHE_ENTRIES) this.blobCache.clear();
    for (const spec of missing) this.blobCache.set(spec, result.get(spec) ?? null);
    return result;
  }

  /**
   * Extracts one folder of a commit into a directory.
   *
   * @param commit - Commit SHA
   * @param folder - Top-level folder name
   * @param dest - Existing, empty destination directory
   * @throws {HubError} 502 when git or tar fails, 422 when the tree holds links leaving it
   */
  async extract(commit: string, folder: string, dest: string): Promise<void> {
    const { proc: git, clear } = spawnGit(["archive", "--format=tar", `${commit}:${folder}`], { cwd: this.dir });
    try {
      await git.stdin.end();
      const tar = Bun.spawn(["tar", "-x", "-f", "-", "-C", dest, "--no-same-owner"], {
        stdin: git.stdout,
        stdout: "ignore",
        stderr: "pipe",
      });
      const [gitErr, gitCode, tarErr, tarCode] = await Promise.all([
        new Response(git.stderr).text(),
        git.exited,
        new Response(tar.stderr).text(),
        tar.exited,
      ]);
      if (gitCode !== 0) throw new HubError(502, `git archive failed: ${gitErr.trim() || `exit code ${gitCode}`}`);
      if (tarCode !== 0) throw new HubError(502, `tar failed: ${tarErr.trim() || `exit code ${tarCode}`}`);
    } finally {
      clear();
    }
    await assertContainedLinks(dest);
  }
}

/**
 * Rejects symbolic links that are absolute or point outside a directory tree.
 *
 * @param root - The extracted tree
 * @throws {HubError} 422 for the first escaping link
 */
export async function assertContainedLinks(root: string): Promise<void> {
  const glob = new Bun.Glob("**");
  for await (const rel of glob.scan({ cwd: root, dot: true, onlyFiles: false, followSymlinks: false })) {
    const full = path.join(root, rel);
    if (!(await lstat(full)).isSymbolicLink()) continue;
    const target = await readlink(full);
    const resolved = path.resolve(path.dirname(full), target);
    if (path.isAbsolute(target) || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) {
      throw new HubError(422, `Symbolic link "${rel}" points outside the extension`);
    }
  }
}
