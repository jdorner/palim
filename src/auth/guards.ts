/**
 * Safety invariants for user and role administration.
 *
 * These checks prevent administrative changes that would lock everyone out of
 * user management or corrupt built-in infrastructure:
 *
 * - At least one enabled human user must always hold the `admin` role.
 * - An administrator cannot disable themselves or remove their own admin role.
 * - The built-in `system` account cannot be modified, and the `system` role
 *   cannot be assigned to other users.
 * - Built-in roles' permission sets are managed by the catalog and cannot be
 *   edited (they would be reset on the next boot anyway).
 *
 * Guards are pure decision functions over the {@link UserStore}; callers map a
 * returned violation message to an HTTP 409.
 *
 * @module
 */

import { ROLE_ADMIN, ROLE_SYSTEM } from "@shared/auth";
import { SYSTEM_USERNAME } from "./constants";
import type { RoleRecord, UserRecord, UserStore } from "./userStore";

/** A proposed change to a user account. */
export interface UserChange {
  /** New disabled state, when changing it. */
  disabled?: boolean;
  /** Replacement role id set, when changing roles. */
  roleIds?: readonly string[];
}

/**
 * Whether a user is an enabled, human holder of the `admin` role.
 *
 * @param store - The user store.
 * @param user - The user record.
 * @returns True when the user counts toward the "at least one admin" invariant.
 */
function isActiveAdmin(store: UserStore, user: UserRecord): boolean {
  return !user.disabled && user.username !== SYSTEM_USERNAME && store.getUserRoleNames(user.id).includes(ROLE_ADMIN);
}

/**
 * Checks role ids requested for assignment to a (non-system) user.
 *
 * @param store - The user store.
 * @param roleIds - The role ids to assign.
 * @returns A violation message, or null when the assignment is allowed.
 */
export function checkRoleAssignment(store: UserStore, roleIds: readonly string[]): string | null {
  const system = store.getRoleByName(ROLE_SYSTEM);
  if (system && roleIds.includes(system.id)) {
    return `The "${ROLE_SYSTEM}" role is reserved for the built-in system account`;
  }
  return null;
}

/**
 * Checks whether an actor may apply a change to a target user.
 *
 * @param store - The user store.
 * @param actorId - The id of the user performing the change (undefined when unknown).
 * @param target - The user being changed.
 * @param change - The proposed change.
 * @returns A violation message, or null when the change is allowed.
 */
export function checkUserChange(
  store: UserStore,
  actorId: string | undefined,
  target: UserRecord,
  change: UserChange,
): string | null {
  if (target.username === SYSTEM_USERNAME) {
    return "The built-in system account cannot be modified";
  }

  if (change.roleIds !== undefined) {
    const violation = checkRoleAssignment(store, change.roleIds);
    if (violation) return violation;
  }

  const adminRole = store.getRoleByName(ROLE_ADMIN);
  const wasAdmin = isActiveAdmin(store, target);
  const willBeDisabled = change.disabled ?? target.disabled;
  const willHoldAdmin =
    change.roleIds !== undefined
      ? adminRole !== undefined && change.roleIds.includes(adminRole.id)
      : store.getUserRoleNames(target.id).includes(ROLE_ADMIN);
  const willBeAdmin = !willBeDisabled && willHoldAdmin;

  if (actorId === target.id) {
    if (change.disabled === true) return "You cannot disable your own account";
    if (wasAdmin && !willHoldAdmin) return "You cannot remove your own admin role";
  }

  if (wasAdmin && !willBeAdmin) {
    const otherAdmins = store.listUsers().filter((u) => u.id !== target.id && isActiveAdmin(store, u));
    if (otherAdmins.length === 0) {
      return "At least one enabled admin must remain";
    }
  }

  return null;
}

/**
 * Checks whether an actor may delete a target user.
 *
 * Mirrors the disable rules: the system account, the actor's own account, and
 * the last enabled admin cannot be deleted.
 *
 * @param store - The user store.
 * @param actorId - The id of the user performing the delete (undefined when unknown).
 * @param target - The user being deleted.
 * @returns A violation message, or null when the delete is allowed.
 */
export function checkUserDelete(store: UserStore, actorId: string | undefined, target: UserRecord): string | null {
  if (target.username === SYSTEM_USERNAME) {
    return "The built-in system account cannot be deleted";
  }
  if (actorId === target.id) {
    return "You cannot delete your own account";
  }
  if (isActiveAdmin(store, target)) {
    const otherAdmins = store.listUsers().filter((u) => u.id !== target.id && isActiveAdmin(store, u));
    if (otherAdmins.length === 0) {
      return "At least one enabled admin must remain";
    }
  }
  return null;
}

/**
 * Checks whether a role's permission set may be replaced.
 *
 * @param role - The role being edited.
 * @returns A violation message, or null when the edit is allowed.
 */
export function checkRolePermissionsChange(role: RoleRecord): string | null {
  if (role.builtIn) {
    return `Built-in role "${role.name}" cannot be edited`;
  }
  return null;
}

/**
 * Checks whether a role may be deleted.
 *
 * Built-in roles are re-seeded on boot and cannot be deleted. Roles still
 * assigned to users must be unassigned first so that deleting a role never
 * silently strips access from someone.
 *
 * @param store - The user store.
 * @param role - The role being deleted.
 * @returns A violation message, or null when the delete is allowed.
 */
export function checkRoleDelete(store: UserStore, role: RoleRecord): string | null {
  if (role.builtIn) {
    return `Built-in role "${role.name}" cannot be deleted`;
  }
  const assigned = store.countUsersByRole().get(role.id) ?? 0;
  if (assigned > 0) {
    return `Role "${role.name}" is still assigned to ${assigned} user${assigned === 1 ? "" : "s"}`;
  }
  return null;
}
