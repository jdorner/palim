/**
 * CASL ability builder: translates a principal's effective permissions into an
 * enforceable {@link AppAbility}.
 *
 * This module is import-safe from both the backend (route guards, WS filtering)
 * and the frontend (UI gating), depending only on `@casl/ability` and the pure
 * shared permission catalog in `@shared/auth`. The same builder runs on both
 * sides from a {@link SerializedAbility} payload so authorization decisions
 * cannot drift between server enforcement and client rendering.
 *
 * Reads are not permission-gated: every principal may read every
 * {@link READABLE_SUBJECTS} subject. `Session` is the only ownership-scoped
 * subject and is granted with a `{ userId: <id> }` condition so a non-admin can
 * only read and act on their own chats. Writes are gated by permission alone;
 * admins receive `manage all`.
 *
 * @module
 */

import { AbilityBuilder, createMongoAbility, type MongoAbility, subject } from "@casl/ability";
import {
  type AppAction,
  type AppSubject,
  PERMISSIONS,
  type Permission,
  type PermissionSet,
  READABLE_SUBJECTS,
  type SerializedAbility,
} from "@shared/auth";

export type { PermissionSet };

/** The concrete CASL ability type used throughout the app. */
export type AppAbility = MongoAbility<[AppAction, AppSubject | Record<string, unknown>]>;

/**
 * Tags a plain resource object with its CASL subject type so ownership
 * conditions can be evaluated against it.
 *
 * Prefer this over hand-writing `__caslSubjectType__`: e.g.
 * `ability.can("read", ownedSubject("Session", { userId }))`.
 *
 * @param type - The subject type name (e.g. "Session").
 * @param resource - The resource fields ownership conditions match against.
 * @returns The resource tagged for CASL subject detection.
 */
export function ownedSubject<T extends Record<string, unknown>>(type: AppSubject, resource: T): T {
  return subject(type as string, resource);
}

/** Input describing the principal an ability is built for. */
export interface AbilityPrincipal {
  /** The principal's opaque user id, matched by ownership conditions. */
  userId: string;
  /** Whether the principal holds the superuser (`admin`) role. */
  isAdmin: boolean;
  /** The principal's effective permission set (ignored when `isAdmin`). */
  permissions: PermissionSet;
}

/**
 * Maps a single permission string to CASL `can` grants.
 *
 * Only `Session` writes are constrained by a `{ userId }` condition; all other
 * grants apply to every resource of the subject type.
 *
 * @param can - The CASL builder's `can` function.
 * @param permission - The permission string to translate.
 * @param userId - The principal's id, used in session ownership conditions.
 */
function applyPermission(can: AbilityBuilder<AppAbility>["can"], permission: Permission, userId: string): void {
  switch (permission) {
    case PERMISSIONS.CHAT_WRITE:
      can("create", "Session");
      can("update", "Session", { userId });
      can("delete", "Session", { userId });
      break;
    case PERMISSIONS.WORKFLOWS_WRITE:
      can(["create", "update", "delete"], "WorkflowRun");
      break;
    case PERMISSIONS.WORKFLOWS_MANAGE:
      can("manage", "Workflow");
      break;
    case PERMISSIONS.JOBS_WRITE:
      can(["update", "delete"], "Job");
      break;
    case PERMISSIONS.TRIGGERS_WRITE:
      can(["create", "update", "delete"], "Trigger");
      break;
    case PERMISSIONS.SECRETS_WRITE:
      can("manage", "Secret");
      break;
    case PERMISSIONS.VARIABLES_WRITE:
      can("manage", "Variable");
      break;
    case PERMISSIONS.MODELS_WRITE:
      can("update", "Model");
      break;
    case PERMISSIONS.EXTENSIONS_WRITE:
      can("manage", "Extension");
      break;
    case PERMISSIONS.USERS_MANAGE:
      can("manage", "User");
      break;
    default:
      // Unknown permission strings grant nothing (deny by default).
      break;
  }
}

/**
 * Builds a CASL ability for a principal from their permission set.
 *
 * Admins receive an unconditional `manage all`. Non-admins may read every
 * {@link READABLE_SUBJECTS} subject and their own sessions, plus the write
 * grants derived from each permission.
 *
 * @param principal - The principal's id, admin flag, and effective permissions.
 * @returns An {@link AppAbility} ready for `can(action, subject)` checks.
 */
export function buildAbility(principal: AbilityPrincipal): AppAbility {
  const builder = new AbilityBuilder<AppAbility>(createMongoAbility);

  if (principal.isAdmin) {
    builder.can("manage", "all");
    return builder.build();
  }

  builder.can("read", [...READABLE_SUBJECTS] as AppSubject[]);
  builder.can("read", "Session", { userId: principal.userId });

  for (const permission of principal.permissions) {
    applyPermission(builder.can, permission, principal.userId);
  }

  return builder.build();
}

/**
 * Rebuilds an ability from a {@link SerializedAbility} payload.
 *
 * Used by the frontend (and any consumer holding only the serialized shape) to
 * reconstruct the exact same ability the backend enforces.
 *
 * @param serialized - The serialized ability payload from `GET /api/auth/me`.
 * @returns An {@link AppAbility} equivalent to the backend's.
 */
export function abilityFromSerialized(serialized: SerializedAbility): AppAbility {
  return buildAbility({
    userId: serialized.userId,
    isAdmin: serialized.isAdmin,
    permissions: serialized.permissions,
  });
}
