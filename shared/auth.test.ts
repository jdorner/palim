import { describe, expect, test } from "bun:test";
import {
  ALL_PERMISSIONS,
  BUILT_IN_ROLES,
  canPerform,
  PERMISSIONS,
  ROLE_ADMIN,
  ROLE_SYSTEM,
  ROLE_USER,
  type SerializedAbility,
} from "./auth";

describe("PERMISSIONS catalog", () => {
  test("all permission values are unique", () => {
    const values = Object.values(PERMISSIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  test("ALL_PERMISSIONS lists every catalog value", () => {
    expect(ALL_PERMISSIONS.length).toBe(Object.values(PERMISSIONS).length);
  });

  test("every permission is a <domain>:<action> string", () => {
    for (const perm of ALL_PERMISSIONS) {
      expect(perm).toContain(":");
    }
  });
});

describe("BUILT_IN_ROLES", () => {
  test("defines admin, user, and system", () => {
    expect(BUILT_IN_ROLES[ROLE_ADMIN]).not.toBeUndefined();
    expect(BUILT_IN_ROLES[ROLE_USER]).not.toBeUndefined();
    expect(BUILT_IN_ROLES[ROLE_SYSTEM]).not.toBeUndefined();
  });

  test("admin is a superuser (null permissions)", () => {
    expect(BUILT_IN_ROLES[ROLE_ADMIN]?.permissions).toBeNull();
  });

  test("user role excludes users:manage and secret writes", () => {
    const perms = BUILT_IN_ROLES[ROLE_USER]?.permissions ?? [];
    expect(perms).not.toContain(PERMISSIONS.USERS_MANAGE);
    expect(perms).not.toContain(PERMISSIONS.SECRETS_WRITE);
    expect(perms).not.toContain(PERMISSIONS.EXTENSIONS_WRITE);
  });

  test("system role is narrow: no users:manage, no secret writes", () => {
    const perms = BUILT_IN_ROLES[ROLE_SYSTEM]?.permissions ?? [];
    expect(perms).not.toContain(PERMISSIONS.USERS_MANAGE);
    expect(perms).not.toContain(PERMISSIONS.SECRETS_WRITE);
    expect(perms).not.toContain(PERMISSIONS.TRIGGERS_WRITE);
  });

  test("every non-admin role grants only known permissions", () => {
    for (const role of [BUILT_IN_ROLES[ROLE_USER], BUILT_IN_ROLES[ROLE_SYSTEM]]) {
      for (const perm of role?.permissions ?? []) {
        expect(ALL_PERMISSIONS).toContain(perm);
      }
    }
  });
});

describe("canPerform (dependency-free UI gating)", () => {
  const admin: SerializedAbility = { userId: "admin", isAdmin: true, permissions: [] };
  const user: SerializedAbility = {
    userId: "u1",
    isAdmin: false,
    permissions: [PERMISSIONS.CHAT_WRITE],
  };

  test("admin can do anything", () => {
    expect(canPerform(admin, "manage", "User")).toBe(true);
    expect(canPerform(admin, "delete", "Secret")).toBe(true);
    expect(canPerform(admin, "read", "Session", "someone-else")).toBe(true);
  });

  test("user can manage their own sessions but not others'", () => {
    expect(canPerform(user, "read", "Session", "u1")).toBe(true);
    expect(canPerform(user, "delete", "Session", "u1")).toBe(true);
    expect(canPerform(user, "read", "Session", "u2")).toBe(false);
  });

  test("user can create sessions (no ownership needed)", () => {
    expect(canPerform(user, "create", "Session")).toBe(true);
  });

  test("user cannot manage users", () => {
    expect(canPerform(user, "manage", "User")).toBe(false);
  });

  test("user can read models but not update them", () => {
    expect(canPerform(user, "read", "Model")).toBe(true);
    expect(canPerform(user, "update", "Model")).toBe(false);
  });

  test("user can read everything but other users' sessions without any permission", () => {
    const bare: SerializedAbility = { userId: "u1", isAdmin: false, permissions: [] };
    expect(canPerform(bare, "read", "Secret")).toBe(true);
    expect(canPerform(bare, "read", "WorkflowRun")).toBe(true);
    expect(canPerform(bare, "read", "Session", "u1")).toBe(true);
    expect(canPerform(bare, "read", "Session", "u2")).toBe(false);
    expect(canPerform(bare, "read", "User")).toBe(false);
    expect(canPerform(bare, "create", "Session")).toBe(false);
  });

  test("manage grant subsumes crud actions", () => {
    const secretAdmin: SerializedAbility = {
      userId: "s",
      isAdmin: false,
      permissions: [PERMISSIONS.SECRETS_WRITE],
    };
    expect(canPerform(secretAdmin, "read", "Secret")).toBe(true);
    expect(canPerform(secretAdmin, "delete", "Secret")).toBe(true);
  });
});
