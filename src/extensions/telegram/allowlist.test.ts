import { describe, expect, test } from "bun:test";
import { isChatAllowed, parseChatIdList } from "./allowlist";

describe("parseChatIdList", () => {
  test("takes the string array the settings UI stores", () => {
    expect(parseChatIdList(["123", " -100456 ", ""])).toEqual(["123", "-100456"]);
  });

  test("takes a number or a comma-separated string from an env value", () => {
    expect(parseChatIdList(123)).toEqual(["123"]);
    expect(parseChatIdList("123, -100456,,")).toEqual(["123", "-100456"]);
    expect(parseChatIdList([123, "456"])).toEqual(["123", "456"]);
  });

  test("drops duplicates and anything that is not an ID", () => {
    expect(parseChatIdList(["1", "1", null, {}, true, Number.NaN])).toEqual(["1"]);
  });

  test("yields an empty list when unset", () => {
    expect(parseChatIdList(undefined)).toEqual([]);
    expect(parseChatIdList(null)).toEqual([]);
  });
});

describe("isChatAllowed", () => {
  test("denies every chat when nothing is configured", () => {
    expect(isChatAllowed(123, [], undefined)).toBe(false);
  });

  test("allows listed chats, numeric or string", () => {
    expect(isChatAllowed(123, ["123"], undefined)).toBe(true);
    expect(isChatAllowed("-100456", ["-100456"], undefined)).toBe(true);
    expect(isChatAllowed(124, ["123"], undefined)).toBe(false);
  });

  test("always allows the default chat", () => {
    expect(isChatAllowed(42, [], "42")).toBe(true);
    expect(isChatAllowed(43, [], "42")).toBe(false);
  });

  test("never matches an empty ID", () => {
    expect(isChatAllowed("", [""], "")).toBe(false);
  });
});
