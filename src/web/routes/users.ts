/**
 * Admin user and role management routes.
 *
 * All routes are gated on the `users:manage` permission by the central
 * authorization table (see {@link import("../authorize").authorizeRequest}),
 * which matches `/api/users` and `/api/roles`. Handlers therefore assume the
 * caller is authorized and focus on validation and persistence.
 *
 * Administrative safety invariants (at least one enabled admin, no self-lockout,
 * immutable system account and built-in roles) are enforced via the guards in
 * `src/auth/guards.ts`; violations respond with 409.
 *
 * Password hashes are never returned. Passwords are hashed with argon2id via the
 * auth service before storage.
 *
 * Endpoints:
 * - `GET    /api/users`               - list users (no hashes)
 * - `POST   /api/users`               - create a user with roles
 * - `PATCH  /api/users/:id`           - update display name, locale, roles, disabled, or password
 * - `DELETE /api/users/:id`           - delete a user and their chat sessions (refused while they own triggers)
 * - `GET    /api/roles`               - list roles with their permissions and user counts
 * - `POST   /api/roles`               - create a role
 * - `PATCH  /api/roles/:id`           - update a custom role's description
 * - `DELETE /api/roles/:id`           - delete an unassigned custom role
 * - `PUT    /api/roles/:id/permissions` - replace a role's permission set
 *
 * @module
 */

import { ALL_PERMISSIONS, type Permission } from "@shared/auth";
import { Type } from "@sinclair/typebox";
import {
  type AuthService,
  checkRoleAssignment,
  checkRoleDelete,
  checkRolePermissionsChange,
  checkUserChange,
  checkUserDelete,
  type UserStore,
} from "@src/auth";
import { Elysia } from "elysia";
import { getPrincipal } from "../auth";
import { countTriggersOwnedBy } from "../triggerOwnership";
import { LocaleValue } from "./auth";

/** Body schema for creating a user. */
const CreateUserBody = Type.Object({
  username: Type.String({ minLength: 1, maxLength: 64, description: "Unique login username" }),
  password: Type.String({ minLength: 8, description: "Initial password (min 8 chars)" }),
  displayName: Type.Optional(Type.String({ maxLength: 128 })),
  locale: Type.Optional(LocaleValue),
  roleIds: Type.Optional(Type.Array(Type.String(), { description: "Role ids to assign" })),
});

/** Body schema for updating a user. */
const UpdateUserBody = Type.Object({
  displayName: Type.Optional(Type.String({ maxLength: 128 })),
  locale: Type.Optional(LocaleValue),
  disabled: Type.Optional(Type.Boolean()),
  roleIds: Type.Optional(Type.Array(Type.String())),
  password: Type.Optional(Type.String({ minLength: 8, description: "New password (min 8 chars)" })),
});

/** Body schema for creating a role. */
const CreateRoleBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_-]*$" }),
  description: Type.Optional(Type.String({ maxLength: 256 })),
  permissions: Type.Optional(Type.Array(Type.String())),
});

/** Body schema for updating a role's metadata. */
const UpdateRoleBody = Type.Object({
  description: Type.String({ maxLength: 256, description: "New description (empty string clears it)" }),
});

/** Body schema for replacing a role's permissions. */
const SetPermissionsBody = Type.Object({
  permissions: Type.Array(Type.String(), { description: "Permission strings from the catalog" }),
});

/** Validates that every string is a known permission from the catalog. */
function validatePermissions(perms: string[]): { ok: true; value: Permission[] } | { ok: false; invalid: string } {
  const known = new Set<string>(ALL_PERMISSIONS);
  for (const p of perms) {
    if (!known.has(p)) return { ok: false, invalid: p };
  }
  return { ok: true, value: perms as Permission[] };
}

/**
 * Creates the admin user/role management route group.
 *
 * @param getUserStore - Getter for the user store (undefined during startup).
 * @param getAuthService - Getter for the auth service (for password hashing).
 * @param onAuthChanged - Called after a change to a user's sessions, status, roles, or a role's
 *   permissions, so open WebSockets can be revalidated.
 * @param deleteUserSessions - Deletes the conversation sessions owned by a user and returns how
 *   many were removed; called when the user is deleted.
 * @returns Elysia plugin with user/role management routes.
 */
export function userRoutes(
  getUserStore: () => UserStore | undefined,
  getAuthService: () => AuthService | undefined,
  onAuthChanged?: () => void,
  deleteUserSessions?: (userId: string) => number,
) {
  return new Elysia()
    .get("/api/users", ({ status }) => {
      const store = getUserStore();
      if (!store) return status(503, { error: "User store unavailable" });
      const users = store.listUsers().map((u) => ({
        ...u,
        roles: store.getUserRoleNames(u.id),
      }));
      return status(200, { users });
    })
    .post(
      "/api/users",
      async ({ body, status }) => {
        const store = getUserStore();
        const auth = getAuthService();
        if (!store || !auth) return status(503, { error: "User store unavailable" });

        if (store.getUserByUsername(body.username)) {
          return status(409, { error: `User "${body.username}" already exists` });
        }
        if (body.roleIds) {
          const violation = checkRoleAssignment(store, body.roleIds);
          if (violation) return status(409, { error: violation });
        }

        const passwordHash = await auth.hashPassword(body.password);
        const user = store.createUser({
          username: body.username,
          passwordHash,
          ...(body.displayName ? { displayName: body.displayName } : {}),
          ...(body.locale ? { locale: body.locale } : {}),
        });
        if (body.roleIds && body.roleIds.length > 0) {
          store.setUserRoles(user.id, body.roleIds);
        }
        return status(201, { user: { ...user, roles: store.getUserRoleNames(user.id) } });
      },
      { body: CreateUserBody },
    )
    .patch(
      "/api/users/:id",
      async ({ params, body, request, status }) => {
        const store = getUserStore();
        const auth = getAuthService();
        if (!store || !auth) return status(503, { error: "User store unavailable" });

        const user = store.getUserById(params.id);
        if (!user) return status(404, { error: "User not found" });

        const violation = checkUserChange(store, getPrincipal(request)?.user.id, user, {
          ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
          ...(body.roleIds !== undefined ? { roleIds: body.roleIds } : {}),
        });
        if (violation) return status(409, { error: violation });

        if (body.disabled !== undefined) {
          store.setUserDisabled(user.id, body.disabled);
          // Revoke active sessions when disabling so the change takes effect immediately.
          if (body.disabled) store.deleteSessionsForUser(user.id);
        }
        if (body.roleIds !== undefined) {
          store.setUserRoles(user.id, body.roleIds);
        }
        if (body.displayName !== undefined) {
          store.setDisplayName(user.id, body.displayName.trim() || null);
        }
        if (body.locale !== undefined) {
          store.setLocale(user.id, body.locale);
        }
        if (body.password !== undefined) {
          const passwordHash = await auth.hashPassword(body.password);
          store.setPasswordHash(user.id, passwordHash);
        }
        if (body.disabled !== undefined || body.roleIds !== undefined) onAuthChanged?.();

        const updated = store.getUserById(user.id);
        return status(200, { user: updated ? { ...updated, roles: store.getUserRoleNames(user.id) } : null });
      },
      {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        body: UpdateUserBody,
      },
    )
    .delete(
      "/api/users/:id",
      async ({ params, request, status }) => {
        const store = getUserStore();
        if (!store) return status(503, { error: "User store unavailable" });

        const user = store.getUserById(params.id);
        if (!user) return status(404, { error: "User not found" });

        const violation = checkUserDelete(store, getPrincipal(request)?.user.id, user);
        if (violation) return status(409, { error: violation });

        // Triggers fire with their creator's authority; deleting the creator would make
        // them fail silently, so require them to be removed or reassigned first.
        const owned = await countTriggersOwnedBy(user.id);
        if (owned.length > 0) {
          const list = owned.map(({ kind, count }) => `${count} ${kind}${count === 1 ? "" : "s"}`).join(", ");
          return status(409, { error: `${user.username} still owns ${list}. Delete them first.` });
        }

        store.deleteUser(user.id);
        const deletedSessions = deleteUserSessions?.(user.id) ?? 0;
        onAuthChanged?.();
        return status(200, { ok: true, deletedSessions });
      },
      { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    )
    .get("/api/roles", ({ status }) => {
      const store = getUserStore();
      if (!store) return status(503, { error: "User store unavailable" });
      const userCounts = store.countUsersByRole();
      const roles = store.listRoles().map((r) => ({
        ...r,
        permissions: store.getRolePermissions(r.id),
        userCount: userCounts.get(r.id) ?? 0,
      }));
      return status(200, { roles, availablePermissions: ALL_PERMISSIONS });
    })
    .post(
      "/api/roles",
      ({ body, status }) => {
        const store = getUserStore();
        if (!store) return status(503, { error: "User store unavailable" });
        if (store.getRoleByName(body.name)) {
          return status(409, { error: `Role "${body.name}" already exists` });
        }
        if (body.permissions) {
          const check = validatePermissions(body.permissions);
          if (!check.ok) return status(400, { error: `Unknown permission: ${check.invalid}` });
        }
        const role = store.createRole(body.name, body.description, false);
        if (body.permissions && body.permissions.length > 0) {
          const check = validatePermissions(body.permissions);
          if (check.ok) store.setRolePermissions(role.id, check.value);
        }
        return status(201, { role: { ...role, permissions: store.getRolePermissions(role.id) } });
      },
      { body: CreateRoleBody },
    )
    .patch(
      "/api/roles/:id",
      ({ params, body, status }) => {
        const store = getUserStore();
        if (!store) return status(503, { error: "User store unavailable" });
        const role = store.getRoleById(params.id);
        if (!role) return status(404, { error: "Role not found" });

        const violation = checkRolePermissionsChange(role);
        if (violation) return status(409, { error: violation });

        store.setRoleDescription(role.id, body.description.trim() || null);
        const updated = store.getRoleById(role.id);
        return status(200, { role: updated ? { ...updated, permissions: store.getRolePermissions(role.id) } : null });
      },
      {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        body: UpdateRoleBody,
      },
    )
    .delete(
      "/api/roles/:id",
      ({ params, status }) => {
        const store = getUserStore();
        if (!store) return status(503, { error: "User store unavailable" });
        const role = store.getRoleById(params.id);
        if (!role) return status(404, { error: "Role not found" });

        const violation = checkRoleDelete(store, role);
        if (violation) return status(409, { error: violation });

        store.deleteRole(role.id);
        onAuthChanged?.();
        return status(200, { ok: true });
      },
      { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    )
    .put(
      "/api/roles/:id/permissions",
      ({ params, body, status }) => {
        const store = getUserStore();
        if (!store) return status(503, { error: "User store unavailable" });
        const role = store.getRoleById(params.id);
        if (!role) return status(404, { error: "Role not found" });

        const violation = checkRolePermissionsChange(role);
        if (violation) return status(409, { error: violation });

        const check = validatePermissions(body.permissions);
        if (!check.ok) return status(400, { error: `Unknown permission: ${check.invalid}` });

        store.setRolePermissions(role.id, check.value);
        onAuthChanged?.();
        return status(200, { role: { ...role, permissions: store.getRolePermissions(role.id) } });
      },
      {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        body: SetPermissionsBody,
      },
    );
}
