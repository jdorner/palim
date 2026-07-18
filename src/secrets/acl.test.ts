import { describe, expect, test } from "bun:test";
import { matchesPattern } from "./acl";

describe("matchesPattern", () => {
  test("exact match returns true", () => {
    expect(matchesPattern("ext:telegram", "ext:telegram")).toBe(true);
  });

  test("exact mismatch returns false", () => {
    expect(matchesPattern("ext:telegram", "ext:webhooks")).toBe(false);
  });

  test("global wildcard matches anything", () => {
    expect(matchesPattern("ext:telegram", "*")).toBe(true);
    expect(matchesPattern("workflow:daily-lint", "*")).toBe(true);
    expect(matchesPattern("core:boot", "*")).toBe(true);
  });

  test("prefix wildcard matches same prefix", () => {
    expect(matchesPattern("workflow:daily-lint", "workflow:*")).toBe(true);
    expect(matchesPattern("workflow:gitea-check", "workflow:*")).toBe(true);
  });

  test("prefix wildcard does not match different prefix", () => {
    expect(matchesPattern("ext:telegram", "workflow:*")).toBe(false);
  });

  test("partial name is not a match without wildcard", () => {
    expect(matchesPattern("ext:telegram-bot", "ext:telegram")).toBe(false);
  });
});
