import { describe, expect, test } from "bun:test";
import { countTriggersOwnedBy } from "@src/web/triggerOwnership";
import { createIdentityApi, type IdentityUserLookup } from "./identityApi";
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
];

const lookup: IdentityUserLookup = {
  getUserByUsername: (name) => USERS.find((u) => u.username === name),
  getUserById: (id) => USERS.find((u) => u.id === id),
  listUsers: () => USERS,
};

describe("createIdentityApi", () => {
  test("lists enabled operator usernames, sorted", () => {
    const api = createIdentityApi(lookup, () => null);
    expect(api.listOperatorUsernames()).toEqual(["alice", "zoe"]);
  });

  test("mints a token for an enabled operator with the default TTL", () => {
    const calls: [string, number | undefined][] = [];
    const api = createIdentityApi(lookup, (id, ttl) => {
      calls.push([id, ttl]);
      return `tok-${id}`;
    });
    expect(api.mintToken("alice")).toBe("tok-u2");
    expect(calls).toEqual([["u2", 60 * 60 * 1000]]);
    api.mintToken("zoe", 5000);
    expect(calls[1]).toEqual(["u1", 5000]);
  });

  test("refuses unknown, disabled, and portal accounts", () => {
    const api = createIdentityApi(lookup, () => "tok");
    expect(api.mintToken("nobody")).toBeNull();
    expect(api.mintToken("off")).toBeNull();
    expect(api.mintToken("portal-bob")).toBeNull();
  });

  test("owner counters see usernames and block deletion until removed", async () => {
    const api = createIdentityApi(lookup, () => null);
    const unregister = api.registerOwnerCounter("test binding", (name) => (name === "alice" ? 1 : 0));
    try {
      expect(await countTriggersOwnedBy("u2")).toEqual([{ kind: "test binding", count: 1 }]);
      expect(await countTriggersOwnedBy("u1")).toEqual([]);
      expect(await countTriggersOwnedBy("missing")).toEqual([]);
    } finally {
      unregister();
    }
    expect(await countTriggersOwnedBy("u2")).toEqual([]);
  });
});
