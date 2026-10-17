/**
 * Catalog: what each source offers, merged with what is installed.
 *
 * {@link scanSource} reads a mirror into a {@link SourceSnapshot} (extension
 * folders on the source branch plus `<name>@<version>` release tags).
 * {@link buildCatalog} combines the snapshots with the install records and
 * the registry's loaded extensions into the view served to the UI, including
 * which installs have an update.
 *
 * @module
 */

import { EXTENSION_NAME_PATTERN } from "./git";
import { compareVersions, parsePackageMeta, parseReleaseTag, readmeSummary } from "./packageMeta";
import type { SourceRepo } from "./sources";
import type { InstallRecord, SourceRecord } from "./store";

/** A release (tag) of an extension. */
export interface ReleaseInfo {
  /** Semver version from the tag. */
  version: string;
  /** Tag name. */
  tag: string;
  /** Tagged commit. */
  commit: string;
  /** Whether the version is a prerelease. */
  prerelease: boolean;
  /** Whether the tagged tree can be installed. */
  installable: boolean;
  /** Why it cannot be installed, or a warning (e.g. package.json version differs from the tag). */
  problem: string | null;
}

/** The source branch state of an extension. */
export interface HeadInfo {
  /** Branch name. */
  branch: string;
  /** Branch head commit. */
  commit: string;
  /** package.json version at the head (null when unreadable). */
  version: string | null;
  /** Whether the head tree can be installed. */
  installable: boolean;
  /** Why it cannot be installed. */
  problem: string | null;
}

/** One extension offered by a source. */
export interface SourceExtension {
  /** Folder / package name. */
  name: string;
  /** Description from package.json, else the README's first paragraph. */
  description: string | null;
  /** State on the source branch (null when the folder only exists in tags). */
  head: HeadInfo | null;
  /** Releases, newest first. */
  releases: ReleaseInfo[];
}

/** Everything a source offers, as scanned from its mirror. */
export interface SourceSnapshot {
  /** Branch the snapshot was taken from (null when the mirror has none). */
  branch: string | null;
  /** All branch heads (branch-tracking installs compare against these). */
  branches: Record<string, string>;
  /** Offered extensions, sorted by name. */
  extensions: SourceExtension[];
  /** Scan time (epoch ms). */
  scannedAt: number;
}

/**
 * Scans a source mirror.
 *
 * @param repo - The (cloned) mirror
 * @param branch - Configured branch, or null for the remote default
 * @returns The snapshot
 */
export async function scanSource(repo: SourceRepo, branch: string | null): Promise<SourceSnapshot> {
  const branches = await repo.listBranches();
  const branchName = branch ?? (await repo.defaultBranch());
  const headCommit = branchName ? (branches.get(branchName) ?? null) : null;

  const releasesByName = new Map<
    string,
    Array<{ tag: string; commit: string; version: string; prerelease: boolean }>
  >();
  for (const tag of await repo.listTags()) {
    const parsed = parseReleaseTag(tag.name);
    if (!parsed) continue;
    const list = releasesByName.get(parsed.name) ?? [];
    list.push({ tag: tag.name, commit: tag.commit, version: parsed.version, prerelease: parsed.prerelease });
    releasesByName.set(parsed.name, list);
  }

  const headDirs = headCommit
    ? (await repo.topLevelDirs(headCommit)).filter((d) => EXTENSION_NAME_PATTERN.test(d))
    : [];
  const names = [...new Set([...headDirs, ...releasesByName.keys()])].sort();

  const specs: string[] = [];
  for (const name of names) {
    if (headCommit && headDirs.includes(name)) {
      specs.push(
        `${headCommit}:${name}/index.ts`,
        `${headCommit}:${name}/package.json`,
        `${headCommit}:${name}/README.md`,
      );
    }
    for (const r of releasesByName.get(name) ?? []) {
      specs.push(`${r.commit}:${name}/index.ts`, `${r.commit}:${name}/package.json`);
    }
  }
  const files = await repo.readFiles(specs);
  const file = (commit: string, rel: string) => files.get(`${commit}:${rel}`) ?? null;

  const extensions: SourceExtension[] = [];
  for (const name of names) {
    let head: HeadInfo | null = null;
    let description: string | null = null;
    if (headCommit && branchName && headDirs.includes(name) && file(headCommit, `${name}/index.ts`) !== null) {
      const meta = parsePackageMeta(file(headCommit, `${name}/package.json`), name);
      head = {
        branch: branchName,
        commit: headCommit,
        version: meta.ok ? meta.meta.version : null,
        installable: meta.ok,
        problem: meta.ok ? null : meta.reason,
      };
      description = (meta.ok ? meta.meta.description : null) ?? readmeSummary(file(headCommit, `${name}/README.md`));
    }

    const releases: Array<ReleaseInfo & { description: string | null }> = [];
    for (const r of releasesByName.get(name) ?? []) {
      let installable = false;
      let problem: string | null;
      let releaseDescription: string | null = null;
      if (file(r.commit, `${name}/index.ts`) === null) {
        problem = `${name}/index.ts is missing at this tag`;
      } else {
        const meta = parsePackageMeta(file(r.commit, `${name}/package.json`), name);
        installable = meta.ok;
        problem = meta.ok ? null : meta.reason;
        if (meta.ok && meta.meta.version !== r.version) {
          problem = `package.json version ${meta.meta.version} differs from the tag`;
        }
        if (meta.ok) releaseDescription = meta.meta.description;
      }
      releases.push({
        version: r.version,
        tag: r.tag,
        commit: r.commit,
        prerelease: r.prerelease,
        installable,
        problem,
        description: releaseDescription,
      });
    }
    releases.sort((a, b) => compareVersions(b.version, a.version));

    // Folders without index.ts on the branch and without releases are not extensions.
    if (!head && releases.length === 0) continue;
    extensions.push({
      name,
      description: releases.find((r) => r.description)?.description ?? description,
      head,
      releases: releases.map(({ description: _, ...release }) => release),
    });
  }

  return { branch: branchName, branches: Object.fromEntries(branches), extensions, scannedAt: Date.now() };
}

/** Returns the release with the highest version. */
function latestOf<T extends { version: string }>(list: T[]): T | undefined {
  return list.reduce<T | undefined>(
    (best, r) => (!best || compareVersions(r.version, best.version) > 0 ? r : best),
    undefined,
  );
}

/**
 * Picks the newest installable release.
 *
 * @param releases - Releases of one extension
 * @param includePrereleases - Whether prereleases count
 * @returns The release, or null
 */
export function latestRelease(releases: ReleaseInfo[], includePrereleases: boolean): ReleaseInfo | null {
  const candidates = releases.filter((r) => r.installable && (includePrereleases || !r.prerelease));
  return latestOf(candidates) ?? null;
}

/** An available update of an installed extension. */
export interface UpdateInfo {
  /** Ref to install (tag or branch). */
  ref: string;
  /** Target commit. */
  commit: string;
  /** Target version (null when unknown, e.g. a branch head with a broken package.json). */
  version: string | null;
}

/**
 * Determines whether an installed extension has an update.
 *
 * - Tag installs: a higher installable release exists (prereleases only when
 *   enabled or when the installed version is itself a prerelease).
 * - Branch installs: the branch head moved to another commit.
 * - Commit installs are pinned and never updated.
 *
 * @param install - The install record
 * @param snapshot - Snapshot of the install's source (null when not scanned)
 * @param includePrereleases - The hub setting
 * @returns The update, or null
 */
export function findUpdate(
  install: InstallRecord,
  snapshot: SourceSnapshot | null,
  includePrereleases: boolean,
): UpdateInfo | null {
  if (!snapshot) return null;
  if (install.refKind === "tag") {
    const ext = snapshot.extensions.find((e) => e.name === install.name);
    const allowPre = includePrereleases || parseReleaseTag(`x@${install.version}`)?.prerelease === true;
    const latest = ext ? latestRelease(ext.releases, allowPre) : null;
    if (latest && compareVersions(latest.version, install.version) > 0) {
      return { ref: latest.tag, commit: latest.commit, version: latest.version };
    }
    return null;
  }
  if (install.refKind === "branch") {
    const commit = snapshot.branches[install.ref];
    if (!commit || commit === install.commit) return null;
    const ext = snapshot.extensions.find((e) => e.name === install.name);
    const version = ext?.head?.branch === install.ref && ext.head.commit === commit ? ext.head.version : null;
    return { ref: install.ref, commit, version };
  }
  return null;
}

/** A loaded extension as reported by the registry. */
export interface LoadedInfo {
  /** Manifest version. */
  version: string;
  /** Lifecycle state. */
  state: "active" | "suspended";
  /** Whether the operator enabled it. */
  enabled: boolean;
  /** Activation error, if any. */
  error: string | null;
}

/** An installed extension in the catalog view. */
export interface InstalledView {
  /** Source id. */
  sourceId: string;
  /** Installed ref. */
  ref: string;
  /** Ref kind. */
  refKind: InstallRecord["refKind"];
  /** Installed package version. */
  version: string;
  /** Installed commit. */
  commit: string;
  /** Install time (epoch ms). */
  installedAt: number;
  /** Installer's user id. */
  installedBy: string | null;
  /** Registry state (null = not loaded). */
  loaded: LoadedInfo | null;
  /** Whether a rollback backup exists. */
  canRollback: boolean;
  /** Version the rollback would restore. */
  previousVersion: string | null;
}

/** One catalog row. */
export interface CatalogEntry extends SourceExtension {
  /** Source id. */
  sourceId: string;
  /** Newest installable release (respecting the prerelease setting). */
  latest: ReleaseInfo | null;
  /** Install state (null = not installed from this source). */
  installed: InstalledView | null;
  /** Available update of the install. */
  update: UpdateInfo | null;
  /** A local (hand-placed) folder of the same name blocks installing. */
  blockedByLocal: boolean;
}

/** A source in the catalog view. */
export interface CatalogSource {
  /** Source id. */
  id: string;
  /** Display name. */
  name: string;
  /** Remote URL. */
  url: string;
  /** Configured branch (null = remote default). */
  branch: string | null;
  /** Branch actually scanned. */
  scannedBranch: string | null;
  /** Last successful fetch (epoch ms). */
  lastFetchedAt: number | null;
  /** Last fetch error. */
  lastError: string | null;
  /** Offered extensions. */
  extensions: CatalogEntry[];
}

/** An extension folder in the external directory that the hub did not install. */
export interface LocalExtension {
  /** Folder name. */
  folder: string;
  /** Loaded manifest name and version (null = not loaded). */
  loaded: (LoadedInfo & { name: string }) | null;
}

/** The full catalog view. */
export interface CatalogView {
  /** Sources with their extensions. */
  sources: CatalogSource[];
  /** Installs whose source or extension no longer exists. */
  orphans: Array<{ name: string; installed: InstalledView }>;
  /** Hand-placed extensions (never touched by the hub). */
  local: LocalExtension[];
  /** Number of installs with an update. */
  updateCount: number;
}

/** Inputs of {@link buildCatalog}. */
export interface CatalogInputs {
  /** Registered sources. */
  sources: SourceRecord[];
  /** Snapshots by source id. */
  snapshots: Map<string, SourceSnapshot>;
  /** Install records. */
  installs: InstallRecord[];
  /** Loaded extensions by folder name (external directory only). */
  loadedByFolder: Map<string, LoadedInfo & { name: string }>;
  /** Folder names present in the external extensions directory. */
  folders: string[];
  /** Hub setting. */
  includePrereleases: boolean;
}

/**
 * Builds the catalog view.
 *
 * @param inputs - Sources, snapshots, installs, registry state, folders, settings
 * @returns The view
 */
export function buildCatalog(inputs: CatalogInputs): CatalogView {
  const { sources, snapshots, installs, loadedByFolder, folders, includePrereleases } = inputs;
  const installsByName = new Map(installs.map((i) => [i.name, i]));
  const managed = new Set(installs.map((i) => i.name));
  const localFolders = new Set(folders.filter((f) => !managed.has(f)));
  let updateCount = 0;
  const shown = new Set<string>();

  const view = (install: InstallRecord): InstalledView => {
    const loaded = loadedByFolder.get(install.name);
    return {
      sourceId: install.sourceId,
      ref: install.ref,
      refKind: install.refKind,
      version: install.version,
      commit: install.commit,
      installedAt: install.installedAt,
      installedBy: install.installedBy,
      loaded: loaded
        ? { version: loaded.version, state: loaded.state, enabled: loaded.enabled, error: loaded.error }
        : null,
      canRollback: install.previous !== null,
      previousVersion: install.previous?.version ?? null,
    };
  };

  const catalogSources: CatalogSource[] = sources.map((source) => {
    const snapshot = snapshots.get(source.id) ?? null;
    const extensions: CatalogEntry[] = (snapshot?.extensions ?? []).map((ext) => {
      const install = installsByName.get(ext.name);
      const own = install && install.sourceId === source.id ? install : null;
      const update = own ? findUpdate(own, snapshot, includePrereleases) : null;
      if (own) shown.add(own.name);
      if (update) updateCount++;
      return {
        ...ext,
        sourceId: source.id,
        latest: latestRelease(ext.releases, includePrereleases),
        installed: own ? view(own) : null,
        update,
        blockedByLocal: localFolders.has(ext.name),
      };
    });
    return {
      id: source.id,
      name: source.name,
      url: source.url,
      branch: source.branch,
      scannedBranch: snapshot?.branch ?? null,
      lastFetchedAt: source.lastFetchedAt,
      lastError: source.lastError,
      extensions,
    };
  });

  const orphans = installs.filter((i) => !shown.has(i.name)).map((i) => ({ name: i.name, installed: view(i) }));
  const local = [...localFolders].sort().map((folder) => ({ folder, loaded: loadedByFolder.get(folder) ?? null }));
  return { sources: catalogSources, orphans, local, updateCount };
}
