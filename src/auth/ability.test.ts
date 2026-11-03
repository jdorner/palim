import { describe, expect, test } from "bun:test";
import { BUILT_IN_ROLES, PERMISSIONS, ROLE_SYSTEM, ROLE_USER } from "@shared/auth";
import { buildAbility, ownedSubject } from "./ability";

/** The user role's permission set, guaranteed non-null by the built-in definition. */
const USER_PERMS = BUILT_IN_ROLES[ROLE_USER]?.permissions ?? [];
/** The system role's permission set, guaranteed non-null by the built-in definition. */
const SYSTEM_PERMS = BUILT_IN_ROLES[ROLE_SYSTEM]?.permissions ?? [];

describe("buildAbility", () => {
  describe("admin", () => {
    test("can manage all subjects", () => {
      const ability = buildAbility({ userId: "admin-1", isAdmin: true, permissions: [] });
      expect(ability.can("manage", "all")).toBe(true);
      expect(ability.can("manage", "User")).toBe(true);
      expect(ability.can("delete", "Secret")).toBe(true);
    });

    test("can read and delete any session regardless of owner", () => {
      const ability = buildAbility({ userId: "admin-1", isAdmin: true, permissions: [] });
      expect(ability.can("read", ownedSubject("Session", { userId: "someone-else" }))).toBe(true);
      expect(ability.can("delete", ownedSubject("Session", { userId: "someone-else" }))).toBe(true);
    });
  });

  describe("standard user", () => {
    const userId = "user-1";
    const ability = buildAbility({ userId, isAdmin: false, permissions: USER_PERMS });

    test("can read and delete own session", () => {
      const own = ownedSubject("Session", { userId });
      expect(ability.can("read", own)).toBe(true);
      expect(ability.can("delete", own)).toBe(true);
      expect(ability.can("update", own)).toBe(true);
    });

    test("cannot read or delete another user's session", () => {
      const other = ownedSubject("Session", { userId: "user-2" });
      expect(ability.can("read", other)).toBe(false);
      expect(ability.can("delete", other)).toBe(false);
    });

    test("can create sessions (no owner yet at creation)", () => {
      expect(ability.can("create", "Session")).toBe(true);
    });

    test("cannot manage users", () => {
      expect(ability.can("manage", "User")).toBe(false);
    });

    test("cannot write secrets or extensions", () => {
      expect(ability.can("manage", "Secret")).toBe(false);
      expect(ability.can("manage", "Extension")).toBe(false);
    });

    test("can read models and extensions", () => {
      expect(ability.can("read", "Model")).toBe(true);
      expect(ability.can("read", "Extension")).toBe(true);
    });

    test("can read secrets and variables but not write them", () => {
      expect(ability.can("read", "Secret")).toBe(true);
      expect(ability.can("read", "Variable")).toBe(true);
      expect(ability.can("update", "Secret")).toBe(false);
      expect(ability.can("update", "Variable")).toBe(false);
    });

    test("can modify other users' workflow runs, jobs, and triggers", () => {
      for (const type of ["WorkflowRun", "Job", "Trigger"] as const) {
        const other = ownedSubject(type, { userId: "user-2" });
        expect(ability.can("read", other)).toBe(true);
        expect(ability.can("delete", other)).toBe(true);
      }
    });

    test("cannot edit workflow definitions", () => {
      expect(ability.can("read", "Workflow")).toBe(true);
      expect(ability.can("update", "Workflow")).toBe(false);
    });

    test("cannot change the selected model", () => {
      expect(ability.can("update", "Model")).toBe(false);
    });
  });

  describe("system principal", () => {
    const ability = buildAbility({ userId: "system", isAdmin: false, permissions: SYSTEM_PERMS });

    test("is denied users:manage", () => {
      expect(ability.can("manage", "User")).toBe(false);
    });

    test("is denied secret writes", () => {
      expect(ability.can("manage", "Secret")).toBe(false);
    });

    test("can read workflow runs and enqueue chat, but not modify triggers", () => {
      expect(ability.can("create", "Session")).toBe(true);
      expect(ability.can("read", "WorkflowRun")).toBe(true);
      expect(ability.can("update", "Trigger")).toBe(false);
    });
  });

  describe("unknown permissions", () => {
    test("grant nothing beyond the implicit reads", () => {
      const ability = buildAbility({
        userId: "user-1",
        isAdmin: false,
        permissions: ["totally:bogus" as never],
      });
      expect(ability.can("create", "Session")).toBe(false);
      expect(ability.can("read", ownedSubject("Session", { userId: "user-2" }))).toBe(false);
      expect(ability.can("read", "User")).toBe(false);
      expect(ability.can("manage", "all")).toBe(false);
    });
  });
});

describe("portal accounts and hitl permissions", () => {
  test("a portal account gets no implicit reads, only its permission grants", () => {
    const ability = buildAbility({
      userId: "p",
      isAdmin: false,
      permissions: [PERMISSIONS.HITL_RESPOND],
      kind: "portal",
    });
    expect(ability.can("read", "Workflow")).toBe(false);
    expect(ability.can("read", "Job")).toBe(false);
    expect(ability.can("update", "HumanTask")).toBe(true);
    expect(ability.can("delete", "HumanTask")).toBe(false);
  });

  test("hitl:manage grants manage on human tasks; operators keep implicit reads", () => {
    const ability = buildAbility({ userId: "o", isAdmin: false, permissions: [PERMISSIONS.HITL_MANAGE] });
    expect(ability.can("delete", "HumanTask")).toBe(true);
    expect(ability.can("read", "Workflow")).toBe(true);
  });
});
