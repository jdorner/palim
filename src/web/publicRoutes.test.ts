import { describe, expect, test } from "bun:test";
import { compileRoutePattern, PublicRouteTable } from "./publicRoutes";

describe("compileRoutePattern", () => {
  test("matches params as single non-empty segments", () => {
    const re = compileRoutePattern("/ext/webhooks/receive/:slug");
    expect(re.test("/ext/webhooks/receive/github")).toBe(true);
    expect(re.test("/ext/webhooks/receive/")).toBe(false);
    expect(re.test("/ext/webhooks/receive/a/b")).toBe(false);
  });

  test("escapes literal segments", () => {
    const re = compileRoutePattern("/ext/a.b/cb");
    expect(re.test("/ext/a.b/cb")).toBe(true);
    expect(re.test("/ext/aXb/cb")).toBe(false);
  });

  test("trailing wildcard matches the rest of the path", () => {
    const re = compileRoutePattern("/ext/files/*");
    expect(re.test("/ext/files/a/b/c")).toBe(true);
  });
});

describe("PublicRouteTable", () => {
  test("matches on method and path", () => {
    const table = new PublicRouteTable();
    table.add("GET", "/ext/imap-fetch/oauth/callback");
    expect(table.matches("GET", "/ext/imap-fetch/oauth/callback")).toBe(true);
    expect(table.matches("get", "/ext/imap-fetch/oauth/callback")).toBe(true);
    expect(table.matches("POST", "/ext/imap-fetch/oauth/callback")).toBe(false);
    expect(table.matches("GET", "/ext/imap-fetch/accounts")).toBe(false);
  });
});
