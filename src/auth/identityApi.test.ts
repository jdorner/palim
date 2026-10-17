import { describe, expect, test } from "bun:test";
import { countTriggersOwnedBy, registerTriggerOwnerCounter } from "@src/web/triggerOwnership";
import { createIdentityApi, type IdentityApiOptions, type IdentityUserLookup } from "./identityApi";
import type { UserRecord } from "./userStore";

function user(id: string, username: string, overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id,
    username,
    provider: "local",
    disabled: false,
    kind: "operator",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const USERS = [
  user("u1", "zoe"),
  user("u2", "alice"),
  user("u3", "off", { disabled: true }),
  user("u4", "portal-bob", { kind: "portal" }),
  user("u5", "root"),
  user("u6", "system"),
  user("u7", "svc"),
];

const ROLES: Record<string, string[]> = { u1: ["user"], u2: ["viewer"], u5: ["admin"], u6: ["system"], u7: ["system"] };

const lookup: IdentityUserLookup = {
  getUserByUsername: (name) => USERS.find((u) => u.username === name),
  getUserById: (id) => USERS.find((u) => u.id === id),
  listUsers: () => USERS,
  getUserRoleNames: (id) => ROLES[id] ?? [],
};

function api(overrides: Partial<IdentityApiOptions> = {}) {
  const logs: string[] = [];
  const identity = createIdentityApi(lookup, {
    extensionName: "ext-a",
    log: (m) => logs.push(m),
    mint: () => null,
    ...overrides,
  });
  return { identity, logs };
}

describe("createIdentityApi", () => {
  test("lists enabled, non-privileged operator usernames, sorted", () => {
    expect(api().identity.listOperatorUsernames()).toEqual(["alice", "zoe"]);
  });

  test("mints a token for a usable operator with the default TTL and logs it", () => {
    const calls: [string, number | undefined][] = [];
    const { identity, logs } = api({
      mint: (id, ttl) => {
        calls.push([id, ttl]);
        return `tok-${id}`;
      },
    });
    expect(identity.mintToken("alice")).toBe("tok-u2");
    expect(calls).toEqual([["u2", 60 * 60 * 1000]]);
    expect(logs).toEqual(['Extension "ext-a" minted a token for user "alice"']);
    identity.mintToken("zoe", 5000);
    expect(calls[1]).toEqual(["u1", 5000]);
  });

  test("refuses unknown, disabled, portal, admin, and system accounts without minting", () => {
    let minted = 0;
    const { identity, logs } = api({
      mint: () => {
        minted++;
        return "tok";
      },
    });
    for (const name of ["nobody", "off", "portal-bob", "root", "system", "svc"]) {
      expect(identity.mintToken(name)).toBeNull();
    }
    expect(minted).toBe(0);
    expect(logs).toEqual([]);
  });

  test("owner counters see usernames and block deletion until removed", async () => {
    const unregister = api().identity.registerOwnerCounter("test binding", (name) => (name === "alice" ? 1 : 0));
    try {
      expect(await countTriggersOwnedBy("u2")).toEqual([{ kind: "test binding", count: 1 }]);
      expect(await countTriggersOwnedBy("u1")).toEqual([]);
      expect(await countTriggersOwnedBy("missing")).toEqual([]);
    } finally {
      unregister();
    }
    expect(await countTriggersOwnedBy("u2")).toEqual([]);
  });

  test("an extension cannot replace a core counter or another extension's counter", async () => {
    const unregisterCore = registerTriggerOwnerCounter("schedule", (id) => (id === "u2" ? 2 : 0));
    const unregisterA = api().identity.registerOwnerCounter("schedule", () => 0);
    const unregisterB = api({ extensionName: "ext-b" }).identity.registerOwnerCounter("binding", (n) =>
      n === "alice" ? 1 : 0,
    );
    const unregisterA2 = api().identity.registerOwnerCounter("binding", () => 0);
    try {
      expect(await countTriggersOwnedBy("u2")).toEqual([
        { kind: "schedule", count: 2 },
        { kind: "binding", count: 1 },
      ]);
    } finally {
      unregisterA2();
      unregisterB();
      unregisterA();
      unregisterCore();
    }
  });
});
