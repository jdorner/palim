/**
 * package.json and tag parsing for hub-installable extensions.
 *
 * An installable extension folder holds an `index.ts` and a `package.json`
 * whose `name` equals the folder name and whose `version` is a semver version.
 * Releases are tagged `<name>@<version>` (e.g. `imap-fetch@1.3.0`). Both are
 * read as plain data, so nothing from the repository is executed before an
 * admin installs it.
 *
 * @module
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { EXTENSION_NAME_PATTERN } from "./git";

/** Semantic version (semver.org), without a leading `v`. */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The package.json fields the hub reads (others are ignored). */
const PackageJsonSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  description: Type.Optional(Type.String()),
});

/** Metadata of an extension, read from its package.json. */
export interface PackageMeta {
  /** Package name (= folder name). */
  name: string;
  /** Semver version. */
  version: string;
  /** Optional description. */
  description: string | null;
}

/** Result of {@link parsePackageMeta}. */
export type PackageMetaResult = { ok: true; meta: PackageMeta } | { ok: false; reason: string };

/** A parsed `<name>@<version>` release tag. */
export interface ReleaseTag {
  /** Extension (folder) name. */
  name: string;
  /** Semver version. */
  version: string;
  /** Whether the version has a prerelease part (`1.0.0-rc.1`). */
  prerelease: boolean;
}

/**
 * Reports whether a string is a valid semver version.
 *
 * @param version - The candidate version
 * @returns True for e.g. `1.2.3` and `1.2.3-rc.1`
 */
export function isSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

/**
 * Reports whether a semver version is a prerelease.
 *
 * @param version - A valid semver version
 * @returns True when it has a `-prerelease` part
 */
export function isPrerelease(version: string): boolean {
  return SEMVER_PATTERN.exec(version)?.[4] !== undefined;
}

/**
 * Compares two semver versions.
 *
 * @param a - First version
 * @param b - Second version
 * @returns Negative, zero, or positive like a sort comparator
 */
export function compareVersions(a: string, b: string): number {
  return Bun.semver.order(a, b);
}

/**
 * Parses and validates an extension's package.json.
 *
 * @param raw - File content, or null when the file is missing
 * @param folder - The extension folder name the package must be named after
 * @returns The metadata, or the reason the folder is not installable
 */
export function parsePackageMeta(raw: string | null, folder: string): PackageMetaResult {
  if (raw === null) return { ok: false, reason: "package.json is missing" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `package.json is not valid JSON: ${(err as Error).message}` };
  }
  if (!Value.Check(PackageJsonSchema, data)) {
    return { ok: false, reason: "package.json needs string fields name and version" };
  }
  if (data.name !== folder) {
    return { ok: false, reason: `package.json name "${data.name}" does not match folder "${folder}"` };
  }
  if (!isSemver(data.version)) {
    return { ok: false, reason: `package.json version "${data.version}" is not a semver version` };
  }
  return {
    ok: true,
    meta: { name: data.name, version: data.version, description: data.description?.trim() || null },
  };
}

/**
 * Parses a release tag of the form `<name>@<version>`.
 *
 * @param tag - The tag name
 * @returns The parsed tag, or null when the tag does not follow the scheme
 */
export function parseReleaseTag(tag: string): ReleaseTag | null {
  const at = tag.lastIndexOf("@");
  if (at <= 0) return null;
  const name = tag.slice(0, at);
  const version = tag.slice(at + 1);
  if (!EXTENSION_NAME_PATTERN.test(name) || !isSemver(version)) return null;
  return { name, version, prerelease: isPrerelease(version) };
}

/**
 * Builds the release tag name for an extension version.
 *
 * @param name - Extension name
 * @param version - Semver version
 * @returns The tag, e.g. `imap-fetch@1.3.0`
 */
export function releaseTag(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Extracts a one-paragraph description from a README (first non-heading paragraph).
 *
 * @param readme - README content, or null
 * @returns The paragraph (max 300 chars), or null
 */
export function readmeSummary(readme: string | null): string | null {
  if (!readme) return null;
  for (const block of readme.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (!text || text.startsWith("#") || text.startsWith("```") || text.startsWith("<")) continue;
    const flat = text.replace(/\s+/g, " ");
    return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
  }
  return null;
}
