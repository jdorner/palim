/**
 * Portal workflow launcher contract shared by the launcher registry and the
 * core extension that provides launchers (workflows). Alias-free so it can be
 * re-exported to extensions through `@ext/types`.
 *
 * @module
 */

/** A launcher as declared by its provider (a workflow with a `portal` trigger). */
export interface PortalLauncherDef {
  /** Workflow name (the launcher id). */
  name: string;
  /** Title shown in the portal. */
  title: string;
  /** Optional explanation shown above the form. */
  description: string | null;
  /** Accepted file types (`accept` attribute syntax); null = any. */
  accept: string | null;
  /** Whether a file must be uploaded. */
  fileRequired: boolean;
  /** Maximum upload size in MB. */
  maxSizeMb: number;
  /** JSON Schema (object) of the optional form fields; null when there are none. */
  fields: Record<string, unknown> | null;
  /** Role names that may use the launcher; empty = everyone holding `portal:start`. */
  roles: string[];
  /** Id of the operator account the run executes as; null when not bound. */
  runAsUserId: string | null;
}

/** Supplies launchers and starts them. Registered via `ctx.internal.portal`. */
export interface PortalLauncherProvider {
  /** Lists the currently available launchers (enabled workflows with a `portal` trigger). */
  list(): PortalLauncherDef[];
  /**
   * Starts a launcher.
   *
   * @param name - Launcher (workflow) name
   * @param payload - The trigger payload
   * @param initiatorUserId - Id of the account the run executes as (the checked `runAsUserId`)
   * @returns The started run's id
   * @throws When the launcher no longer exists or the dispatch fails
   */
  start(name: string, payload: unknown, initiatorUserId: string): Promise<{ runId: string }>;
}

/** The portal operations available to core extensions via `ctx.internal.portal`. */
export interface PortalApi {
  /**
   * Registers the launcher provider (one at a time; a later registration replaces it).
   *
   * @returns A function that removes the registration (call it in `shutdown()`)
   */
  registerLauncherProvider(provider: PortalLauncherProvider): () => void;
  /**
   * Describes the account a portal-started run would execute as.
   *
   * @param userId - The bound run-as user id
   * @returns The username and whether the account is usable (exists, enabled, operator); null when it does not exist
   */
  describeRunAs(userId: string): { username: string; usable: boolean } | null;
}
