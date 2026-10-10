/**
 * Pure helpers for the Users & Roles admin page: row types, the client-side
 * mirror of the server's safety guards (src/auth/guards.ts — the server stays
 * authoritative), permission grouping for the matrix editor, and password
 * validation/generation.
 *
 * @module
 */

import { type CoreTranslate, englishT } from "$lib/i18nCore";
import { ROLE_ADMIN, ROLE_SYSTEM } from "$shared/auth";

/** A user row returned by GET /api/users. */
export interface UserRow {
  id: string;
  username: string;
  displayName?: string;
  /** Preferred UI locale; undefined follows the browser language. */
  locale?: string;
  disabled: boolean;
  roles: string[];
}

/** A role row returned by GET /api/roles. */
export interface RoleRow {
  id: string;
  name: string;
  description?: string;
  builtIn: boolean;
  permissions: string[];
  userCount: number;
}

/** Minimum password length accepted by the server. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Whether the row is the built-in, non-login system account.
 *
 * @param user - The user row.
 * @returns True for the system account.
 */
export function isSystemUser(user: UserRow): boolean {
  return user.roles.includes(ROLE_SYSTEM);
}

/**
 * Enabled human admins, which must never drop to zero.
 *
 * @param users - All user rows.
 * @returns The users that count toward the "at least one admin" invariant.
 */
export function activeAdmins(users: readonly UserRow[]): UserRow[] {
  return users.filter((u) => !u.disabled && u.roles.includes(ROLE_ADMIN) && !isSystemUser(u));
}

/**
 * Whether the user is the only remaining enabled admin.
 *
 * @param user - The user row.
 * @param users - All user rows.
 * @returns True when disabling or demoting this user would leave no admin.
 */
export function isLastAdmin(user: UserRow, users: readonly UserRow[]): boolean {
  const admins = activeAdmins(users);
  return admins.length === 1 && admins[0]?.id === user.id;
}

/**
 * Why the user cannot be disabled.
 *
 * @param user - The user row.
 * @param users - All user rows.
 * @param currentUserId - The signed-in user's id.
 * @param t - Translates the reason (default English)
 * @returns A short human-readable reason, or null when disabling is allowed.
 */
export function disableLockReason(
  user: UserRow,
  users: readonly UserRow[],
  currentUserId?: string,
  t: CoreTranslate = englishT,
): string | null {
  if (user.id === currentUserId) return t("users.reasonDisableSelf");
  if (isLastAdmin(user, users)) return t("users.reasonLastAdmin");
  return null;
}

/**
 * Why the user cannot be deleted.
 *
 * @param user - The user row.
 * @param users - All user rows.
 * @param currentUserId - The signed-in user's id.
 * @param t - Translates the reason (default English)
 * @returns A short human-readable reason, or null when deleting is allowed.
 */
export function deleteLockReason(
  user: UserRow,
  users: readonly UserRow[],
  currentUserId?: string,
  t: CoreTranslate = englishT,
): string | null {
  if (isSystemUser(user)) return t("users.reasonDeleteSystem");
  if (user.id === currentUserId) return t("users.reasonDeleteSelf");
  if (isLastAdmin(user, users)) return t("users.reasonLastAdmin");
  return null;
}

/**
 * Why a role cannot be toggled on the user.
 *
 * @param user - The user row.
 * @param role - The role being toggled.
 * @param users - All user rows.
 * @param currentUserId - The signed-in user's id.
 * @param t - Translates the reason (default English)
 * @returns A short human-readable reason, or null when toggling is allowed.
 */
export function roleLockReason(
  user: UserRow,
  role: RoleRow,
  users: readonly UserRow[],
  currentUserId?: string,
  t: CoreTranslate = englishT,
): string | null {
  if (role.name === ROLE_SYSTEM) return t("users.reasonSystemRole");
  if (role.name === ROLE_ADMIN && user.roles.includes(ROLE_ADMIN)) {
    if (user.id === currentUserId) return t("users.reasonRemoveOwnAdmin");
    if (isLastAdmin(user, users)) return t("users.reasonLastAdmin");
  }
  return null;
}

/**
 * Why a role cannot be deleted.
 *
 * @param role - The role row.
 * @param t - Translates the reason (default English)
 * @returns A short human-readable reason, or null when deletion is allowed.
 */
export function roleDeleteLockReason(role: RoleRow, t: CoreTranslate = englishT): string | null {
  if (role.builtIn) return t("users.reasonBuiltInRole");
  if (role.userCount > 0) return t("users.reasonRoleAssigned", { count: role.userCount });
  return null;
}

/**
 * Maps role names (as listed on a user) to role ids.
 *
 * @param roles - All role rows.
 * @param names - Role names to resolve.
 * @returns The ids of the named roles that exist.
 */
export function roleIdsForNames(roles: readonly RoleRow[], names: readonly string[]): string[] {
  const idsByName = new Map(roles.map((r) => [r.name, r.id]));
  return names.map((n) => idsByName.get(n)).filter((id): id is string => id !== undefined);
}

/** Permissions grouped for the resource × action matrix. */
export interface PermissionGroups {
  /** Action columns, in display order. */
  actions: string[];
  /** One row per resource, mapping action to the full permission string. */
  resources: { resource: string; perms: Map<string, string> }[];
}

const ACTION_ORDER = ["read", "write", "manage"];

/**
 * Groups `resource:action` permission strings into matrix rows and columns.
 *
 * Resources keep catalog order; actions are ordered read → write → manage,
 * followed by any other actions alphabetically. Strings without a colon are
 * treated as a resource with a single "access" action.
 *
 * @param permissions - The permission catalog.
 * @returns The grouped rows and the action columns.
 */
export function groupPermissions(permissions: readonly string[]): PermissionGroups {
  const byResource = new Map<string, Map<string, string>>();
  const actions = new Set<string>();
  for (const perm of permissions) {
    const idx = perm.indexOf(":");
    const resource = idx === -1 ? perm : perm.slice(0, idx);
    const action = idx === -1 ? "access" : perm.slice(idx + 1);
    actions.add(action);
    let row = byResource.get(resource);
    if (!row) {
      row = new Map();
      byResource.set(resource, row);
    }
    row.set(action, perm);
  }
  const rank = (a: string) => {
    const i = ACTION_ORDER.indexOf(a);
    return i === -1 ? ACTION_ORDER.length : i;
  };
  return {
    actions: [...actions].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
    resources: [...byResource].map(([resource, perms]) => ({ resource, perms })),
  };
}

/**
 * Validates a new password and its confirmation.
 *
 * @param password - The entered password.
 * @param confirm - The confirmation entry.
 * @param t - Translates the message (default English)
 * @returns An error message, or null when valid.
 */
export function validatePassword(password: string, confirm: string, t: CoreTranslate = englishT): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return t("users.passwordTooShort", { min: MIN_PASSWORD_LENGTH });
  if (password !== confirm) return t("users.passwordMismatch");
  return null;
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/**
 * Generates a random password from an unambiguous alphabet.
 *
 * @param length - Number of characters; defaults to 16.
 * @returns The generated password.
 */
export function generatePassword(length = 16): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
}
