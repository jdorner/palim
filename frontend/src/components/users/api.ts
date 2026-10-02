/**
 * Thin client for the admin user/role routes (`/api/users`, `/api/roles`).
 *
 * Every call throws an Error carrying the server's `error` message on a
 * non-2xx response, so dialogs can show it inline.
 *
 * @module
 */

import { authFetch } from "$lib/auth";
import type { RoleRow, UserRow } from "./userAdmin";

/**
 * Sends a JSON request and returns the parsed body.
 *
 * @param path - API path.
 * @param method - HTTP method.
 * @param body - Optional JSON body.
 * @returns The parsed JSON response.
 * @throws Error with the server's message on a non-2xx response.
 */
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await authFetch(path, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/**
 * Loads all users and roles plus the permission catalog.
 *
 * @returns Users, roles, and the available permission strings.
 * @throws Error when either request fails.
 */
export async function loadUsersAndRoles(): Promise<{ users: UserRow[]; roles: RoleRow[]; permissions: string[] }> {
  const [u, r] = await Promise.all([
    request<{ users: UserRow[] }>("/api/users"),
    request<{ roles: RoleRow[]; availablePermissions: string[] }>("/api/roles"),
  ]);
  return { users: u.users, roles: r.roles, permissions: r.availablePermissions };
}

/** Fields accepted when creating a user. */
export interface CreateUserInput {
  username: string;
  password: string;
  displayName?: string;
  roleIds: string[];
}

/**
 * Creates a user.
 *
 * @param input - The new user's fields.
 * @throws Error on validation or conflict failures.
 */
export async function createUser(input: CreateUserInput): Promise<void> {
  await request("/api/users", "POST", input);
}

/**
 * Applies a partial update to a user.
 *
 * @param id - The user id.
 * @param patch - Fields to change.
 * @throws Error when a safety invariant or validation rejects the change.
 */
export async function updateUser(
  id: string,
  patch: { displayName?: string; disabled?: boolean; roleIds?: string[]; password?: string },
): Promise<void> {
  await request(`/api/users/${encodeURIComponent(id)}`, "PATCH", patch);
}

/**
 * Deletes a user together with their chat sessions.
 *
 * @param id - The user id.
 * @returns How many chat sessions were deleted with the user.
 * @throws Error when a safety invariant blocks it or the user still owns triggers.
 */
export async function deleteUser(id: string): Promise<number> {
  const res = await request<{ deletedSessions: number }>(`/api/users/${encodeURIComponent(id)}`, "DELETE");
  return res.deletedSessions;
}

/**
 * Creates a role.
 *
 * @param input - Name, optional description, and permissions.
 * @throws Error on validation or conflict failures.
 */
export async function createRole(input: { name: string; description?: string; permissions: string[] }): Promise<void> {
  await request("/api/roles", "POST", input);
}

/**
 * Updates a custom role's description and permission set.
 *
 * @param id - The role id.
 * @param description - New description (empty clears it).
 * @param permissions - Replacement permission set.
 * @throws Error when the role is built-in or a permission is unknown.
 */
export async function updateRole(id: string, description: string, permissions: string[]): Promise<void> {
  const path = `/api/roles/${encodeURIComponent(id)}`;
  await request(path, "PATCH", { description });
  await request(`${path}/permissions`, "PUT", { permissions });
}

/**
 * Deletes an unassigned custom role.
 *
 * @param id - The role id.
 * @throws Error when the role is built-in or still assigned.
 */
export async function deleteRole(id: string): Promise<void> {
  await request(`/api/roles/${encodeURIComponent(id)}`, "DELETE");
}
