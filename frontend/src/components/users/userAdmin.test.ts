import { describe, expect, test } from "bun:test";
import {
  deleteLockReason,
  disableLockReason,
  generatePassword,
  groupPermissions,
  type RoleRow,
  roleDeleteLockReason,
  roleIdsForNames,
  roleLockReason,
  type UserRow,
  validatePassword,
} from "./userAdmin";

const role = (name: string, extra: Partial<RoleRow> = {}): RoleRow => ({
  id: `id-${name}`,
  name,
  builtIn: false,
  permissions: [],
  userCount: 0,
  ...extra,
});

const user = (id: string, roles: string[], disabled = false): UserRow => ({ id, username: id, disabled, roles });

describe("user admin guards", () => {
  const root = user("root", ["admin"]);
  const alice = user("alice", ["user"]);
  const system = user("system", ["system"]);

  test("you cannot disable yourself", () => {
    expect(disableLockReason(alice, [root, alice], "alice")).toBe("You cannot disable your own account");
  });

  test("the last enabled admin cannot be disabled or demoted", () => {
    const users = [root, alice, system];
    expect(disableLockReason(root, users, "alice")).toBe("At least one enabled admin must remain");
    expect(roleLockReason(root, role("admin"), users, "alice")).toBe("At least one enabled admin must remain");
  });

  test("a second enabled admin unlocks the first", () => {
    const root2 = user("root2", ["admin"]);
    expect(disableLockReason(root, [root, root2], "alice")).toBeNull();
    expect(roleLockReason(root, role("admin"), [root, root2], "alice")).toBeNull();
  });

  test("a disabled admin does not count", () => {
    const root2 = user("root2", ["admin"], true);
    expect(disableLockReason(root, [root, root2], "alice")).not.toBeNull();
  });

  test("delete is blocked for yourself, the last admin, and the system account", () => {
    const users = [root, alice, system];
    expect(deleteLockReason(alice, users, "alice")).toBe("You cannot delete your own account");
    expect(deleteLockReason(root, users, "alice")).toBe("At least one enabled admin must remain");
    expect(deleteLockReason(system, users, "root")).not.toBeNull();
    expect(deleteLockReason(alice, users, "root")).toBeNull();
  });

  test("the system role is never assignable", () => {
    expect(roleLockReason(alice, role("system"), [root, alice], "root")).not.toBeNull();
  });

  test("role deletion is blocked for built-in or assigned roles", () => {
    expect(roleDeleteLockReason(role("user", { builtIn: true }))).not.toBeNull();
    expect(roleDeleteLockReason(role("editor", { userCount: 2 }))).toContain("2 users");
    expect(roleDeleteLockReason(role("editor"))).toBeNull();
  });

  test("roleIdsForNames skips unknown names", () => {
    expect(roleIdsForNames([role("a"), role("b")], ["b", "zzz"])).toEqual(["id-b"]);
  });
});

describe("groupPermissions", () => {
  test("groups by resource and orders actions read → write → manage", () => {
    const g = groupPermissions(["chat:write", "chat:read", "workflows:manage", "workflows:read", "users:manage"]);
    expect(g.actions).toEqual(["read", "write", "manage"]);
    expect(g.resources.map((r) => r.resource)).toEqual(["chat", "workflows", "users"]);
    expect(g.resources[0]?.perms.get("read")).toBe("chat:read");
    expect(g.resources[2]?.perms.get("read")).toBeUndefined();
  });

  test("unknown actions sort after known ones", () => {
    expect(groupPermissions(["x:zap", "x:read", "x:apply"]).actions).toEqual(["read", "apply", "zap"]);
  });
});

describe("passwords", () => {
  test("validatePassword checks length and confirmation", () => {
    expect(validatePassword("short", "short")).toContain("at least 8");
    expect(validatePassword("longenough", "different")).toBe("Passwords do not match");
    expect(validatePassword("longenough", "longenough")).toBeNull();
  });

  test("generatePassword produces a valid password", () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(16);
    expect(validatePassword(pw, pw)).toBeNull();
  });
});
