/**
 * Portal workflow launcher registry: the bridge between the portal API (web
 * server) and the workflows extension, which provides the launchers. Decides
 * which launchers a viewer may see (roles) and which account a started run
 * executes as (`runAs`).
 *
 * @module
 */

import type { PortalWorkflow } from "@shared/portal";
import { SYSTEM_USERNAME } from "@src/auth/constants";
import type { UserStore } from "@src/auth/userStore";
import type { PortalLauncherDef, PortalLauncherProvider } from "./types";

/** Error with an HTTP status, thrown by the registry. */
export class PortalLauncherError extends Error {
  /**
   * @param status - HTTP status for the response
   * @param message - Error message
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PortalLauncherError";
  }
}

/** The caller a launcher list or start is evaluated for. */
export interface PortalLauncherViewer {
  /** The caller's user id. */
  userId: string;
  /** The caller's role names. */
  roleNames: readonly string[];
  /** Admins see every launcher. */
  isAdmin: boolean;
}

/** Dependencies of {@link createPortalLauncherRegistry}. */
export interface PortalLauncherRegistryDeps {
  /**
   * Describes a run-as account.
   *
   * @returns The username and whether it is usable, or null when the user does not exist
   */
  describeRunAs(userId: string): { username: string; usable: boolean } | null;
}

/** The launcher registry. */
export interface PortalLauncherRegistry {
  /**
   * Registers the launcher provider, replacing any previous one.
   *
   * @returns A function that removes the registration
   */
  register(provider: PortalLauncherProvider): () => void;
  /**
   * Describes a run-as account (see {@link PortalLauncherRegistryDeps.describeRunAs}).
   *
   * @returns The username and usability, or null when the user does not exist
   */
  describeRunAs(userId: string): { username: string; usable: boolean } | null;
  /**
   * Lists the launchers the viewer may use, sorted by title.
   *
   * @param viewer - The caller
   * @returns The launchers as wire objects
   */
  list(viewer: PortalLauncherViewer): PortalWorkflow[];
  /**
   * Returns a launcher the viewer may use.
   *
   * @param name - Launcher name
   * @param viewer - The caller
   * @returns The launcher, or null when it does not exist or is hidden from the viewer
   */
  get(name: string, viewer: PortalLauncherViewer): PortalLauncherDef | null;
  /**
   * Starts a launcher as its `runAs` account.
   *
   * @param def - The launcher (from {@link PortalLauncherRegistry.get})
   * @param payload - The trigger payload
   * @returns The started run's id
   * @throws PortalLauncherError 409 when the run-as account is missing or unusable, 503 without a provider
   */
  start(def: PortalLauncherDef, payload: unknown): Promise<{ runId: string }>;
}

/**
 * Whether a viewer may use a launcher: admins always, otherwise when the
 * launcher has no role restriction or the viewer holds one of its roles.
 *
 * @param def - The launcher
 * @param viewer - The caller
 * @returns True when visible
 */
function canUseLauncher(def: PortalLauncherDef, viewer: PortalLauncherViewer): boolean {
  if (viewer.isAdmin || def.roles.length === 0) return true;
  return def.roles.some((role) => viewer.roleNames.includes(role));
}

/**
 * Describes a run-as account for portal-started runs. Usable means an
 * existing, enabled operator account other than the built-in system account.
 *
 * @param store - The user store
 * @param userId - The bound run-as user id
 * @returns The username and usability, or null when the user does not exist
 */
export function describeRunAsUser(
  store: Pick<UserStore, "getUserById">,
  userId: string,
): { username: string; usable: boolean } | null {
  const user = store.getUserById(userId);
  if (!user) return null;
  const usable = !user.disabled && user.kind === "operator" && user.username !== SYSTEM_USERNAME;
  return { username: user.username, usable };
}

/**
 * Converts a launcher to its wire shape (drops roles and `runAs`).
 *
 * @param def - The launcher
 * @returns The wire object
 */
function toWire(def: PortalLauncherDef): PortalWorkflow {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    accept: def.accept,
    fileRequired: def.fileRequired,
    maxSizeMb: def.maxSizeMb,
    fields: def.fields,
  };
}

/**
 * Creates the launcher registry.
 *
 * @param deps - Account resolution
 * @returns The registry
 */
export function createPortalLauncherRegistry(deps: PortalLauncherRegistryDeps): PortalLauncherRegistry {
  let provider: PortalLauncherProvider | null = null;

  const visible = (viewer: PortalLauncherViewer) =>
    (provider?.list() ?? []).filter((def) => canUseLauncher(def, viewer));

  return {
    register(next) {
      provider = next;
      return () => {
        if (provider === next) provider = null;
      };
    },
    describeRunAs: (userId) => deps.describeRunAs(userId),
    list(viewer) {
      return visible(viewer)
        .map(toWire)
        .sort((a, b) => a.title.localeCompare(b.title));
    },
    get(name, viewer) {
      return visible(viewer).find((def) => def.name === name) ?? null;
    },
    async start(def, payload) {
      if (!provider) throw new PortalLauncherError(503, "Workflows are unavailable");
      const userId = def.runAsUserId;
      if (!userId || !deps.describeRunAs(userId)?.usable) {
        throw new PortalLauncherError(409, `Workflow "${def.name}" has no usable run-as account`);
      }
      return provider.start(def.name, payload, userId);
    },
  };
}
