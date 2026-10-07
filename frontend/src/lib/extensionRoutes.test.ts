import { describe, expect, test } from "bun:test";
import { parsePageRoute, resolveExtensionPath } from "./extensionRoutes";

describe("parsePageRoute", () => {
  const base = "/ext-page/mail/accounts";

  test("returns an empty sub-path at the page root", () => {
    const route = parsePageRoute(base, base);
    expect(route.path).toBe("");
    expect(route.query.toString()).toBe("");
  });

  test("extracts and decodes the sub-path and query", () => {
    const route = parsePageRoute(`${base}/work%20mail/settings/?tab=imap&x=1`, base);
    expect(route.path).toBe("work mail/settings");
    expect(route.query.get("tab")).toBe("imap");
    expect(route.query.get("x")).toBe("1");
  });

  test("ignores paths of other pages", () => {
    expect(parsePageRoute("/ext-page/mail/accountsX/a", base).path).toBe("");
    expect(parsePageRoute("/workflows", base).path).toBe("");
  });
});

describe("resolveExtensionPath", () => {
  test("prefixes relative paths with the extension's routes", () => {
    expect(resolveExtensionPath("mail", "/accounts")).toBe("/ext/mail/accounts");
    expect(resolveExtensionPath("mail", "accounts?x=1")).toBe("/ext/mail/accounts?x=1");
  });

  test("passes core API and extension routes through", () => {
    expect(resolveExtensionPath("mail", "/api/workflows")).toBe("/api/workflows");
    expect(resolveExtensionPath("mail", "/ext/other/x")).toBe("/ext/other/x");
  });
});
