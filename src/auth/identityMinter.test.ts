import { describe, expect, test } from "bun:test";
import { resolveInitiatorToken } from "./identityMinter";

describe("resolveInitiatorToken", () => {
  test("returns null (system identity) when the job has no initiator", () => {
    expect(resolveInitiatorToken(undefined, () => "tok")).toBeNull();
  });

  test("returns the minted token for an active initiator", () => {
    expect(resolveInitiatorToken("u1", (id) => `tok-${id}`)).toBe("tok-u1");
  });

  test("refuses when the initiator is disabled or deleted (minter returns null)", () => {
    expect(() => resolveInitiatorToken("u1", () => null)).toThrow(/disabled, deleted/);
  });

  test("refuses when no minter is wired rather than falling back to system", () => {
    expect(() => resolveInitiatorToken("u1", undefined)).toThrow(/disabled, deleted/);
  });
});
