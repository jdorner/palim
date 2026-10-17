import { describe, expect, test } from "bun:test";
import { HubError } from "./errors";
import { createTokenAccess, pruneTokens, type TokenSecrets, tokenKey } from "./tokens";

/** In-memory secret store; `failing` makes every call throw (no vault). */
function memorySecrets(
  initial: Record<string, string> = {},
  failing = false,
): TokenSecrets & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  const guard = () => {
    if (failing) throw new Error("no master key");
  };
  return {
    data,
    async get(key) {
      guard();
      return data.get(key) ?? null;
    },
    async set(key, value) {
      guard();
      data.set(key, value);
    },
    async delete(key) {
      guard();
      return data.delete(key);
    },
    async keys() {
      guard();
      return [...data.keys()].sort();
    },
  };
}

describe("createTokenAccess", () => {
  test("stores a token and deletes it when cleared (no empty secret is left)", async () => {
    const secrets = memorySecrets();
    const { getToken, setToken } = createTokenAccess(secrets);

    await setToken("s1", "abc");
    expect(await getToken("s1")).toBe("abc");

    await setToken("s1", null);
    expect(secrets.data.has(tokenKey("s1"))).toBe(false);
    expect(await getToken("s1")).toBeNull();

    await setToken("s2", null); // clearing a missing token is fine
    expect(secrets.data.size).toBe(0);
  });

  test("treats an empty stored value as no token", async () => {
    const { getToken } = createTokenAccess(memorySecrets({ [tokenKey("s1")]: "" }));
    expect(await getToken("s1")).toBeNull();
  });

  test("without a vault: storing fails with 503, reading and clearing do not throw", async () => {
    const { getToken, setToken } = createTokenAccess(memorySecrets({}, true));
    await expect(setToken("s1", "abc")).rejects.toBeInstanceOf(HubError);
    await expect(setToken("s1", "abc")).rejects.toMatchObject({ status: 503 });
    expect(await getToken("s1")).toBeNull();
    await setToken("s1", null);
  });
});

describe("pruneTokens", () => {
  test("removes tokens of unknown sources and empty tokens, keeps the rest", async () => {
    const secrets = memorySecrets({
      [tokenKey("live")]: "abc",
      [tokenKey("live-empty")]: "",
      [tokenKey("gone")]: "xyz",
      [tokenKey("gone-empty")]: "",
      UNRELATED_SECRET: "keep",
    });

    const removed = await pruneTokens(secrets, new Set(["live", "live-empty"]));

    expect(removed.sort()).toEqual([tokenKey("gone"), tokenKey("gone-empty"), tokenKey("live-empty")].sort());
    expect([...secrets.data.keys()].sort()).toEqual([tokenKey("live"), "UNRELATED_SECRET"].sort());
  });
});
