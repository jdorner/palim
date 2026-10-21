/**
 * API helpers and shared types for the Extension Hub page.
 */

import type { PalimHost } from "@ext/ui";
import type { CatalogEntry, InstalledView } from "../catalog";
import type { CheckResult, InstallResult, UpdateResult } from "../hub";
import type { SourceRecord } from "../store";

export type {
  CatalogEntry,
  CatalogSource,
  CatalogView,
  InstalledView,
  ReleaseInfo,
  UpdateInfo,
} from "../catalog";
export type { CheckResult, InstallResult, UpdateResult };

/** What the version dialog submits. */
export interface VersionChoice {
  /** Release version. */
  version?: string;
  /** Tag, branch, or commit. */
  ref?: string;
  /** Discard local changes / reinstall the same commit. */
  force?: boolean;
}

/** A source as listed by `GET /sources`. */
export interface SourceInfo extends SourceRecord {
  /** Whether an HTTPS token is stored. */
  hasToken: boolean;
}

/** An API error carrying the HTTP status and server details. */
class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Performs a request and parses the JSON response.
 *
 * @param palim - Host API
 * @param path - Extension-relative path, or `/api/...`
 * @param init - Method and JSON body
 * @returns The parsed body
 * @throws {ApiError} On non-2xx responses
 */
export async function request<T>(
  palim: PalimHost,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await palim.fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // non-JSON body
  }
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? `HTTP ${res.status}`), data.details);
  return data as T;
}

/**
 * Error message helper.
 *
 * @param err - Any thrown value
 * @returns A message
 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shortens a commit SHA for display.
 *
 * @param sha - Full SHA
 * @returns The first 8 characters
 */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * Describes what an install follows, e.g. `foo@1.2.0`, `main`, or `1a2b3c4d`.
 *
 * @param installed - Install state
 * @returns Display text
 */
export function refLabel(installed: Pick<InstalledView, "ref" | "refKind">): string {
  return installed.refKind === "commit" ? shortSha(installed.ref) : installed.ref;
}

/**
 * Whether anything of an extension can be installed.
 *
 * @param entry - Catalog entry
 * @returns True when a release or the branch head is installable
 */
export function isInstallable(entry: CatalogEntry): boolean {
  return entry.releases.some((r) => r.installable) || entry.head?.installable === true;
}

/** Shared input classes. */
export const INPUT_CLASS =
  "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";
