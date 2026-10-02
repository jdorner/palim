import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Context, Elysia } from "elysia";
import { compileRoutePattern, ExtensionRouter } from "./extensionRouter";

const ok = () => new Response("ok");

describe("compileRoutePattern", () => {
  test("matches params as single non-empty segments", () => {
    const { pattern } = compileRoutePattern("/ext/webhooks/receive/:slug");
    expect(pattern.test("/ext/webhooks/receive/github")).toBe(true);
    expect(pattern.test("/ext/webhooks/receive/")).toBe(false);
    expect(pattern.test("/ext/webhooks/receive/a/b")).toBe(false);
  });

  test("escapes literal segments", () => {
    const { pattern } = compileRoutePattern("/ext/a.b/cb");
    expect(pattern.test("/ext/a.b/cb")).toBe(true);
    expect(pattern.test("/ext/aXb/cb")).toBe(false);
  });

  test("trailing slash is optional on pattern and path", () => {
    const { pattern } = compileRoutePattern("/ext/workflows/");
    expect(pattern.test("/ext/workflows")).toBe(true);
    expect(pattern.test("/ext/workflows/")).toBe(true);
    expect(pattern.test("/ext/workflows/x")).toBe(false);
    expect(compileRoutePattern("/ext/wf/:name").pattern.test("/ext/wf/foo/")).toBe(true);
  });

  test("trailing wildcard matches the rest of the path", () => {
    const { pattern } = compileRoutePattern("/ext/files/*");
    expect(pattern.test("/ext/files/a/b/c")).toBe(true);
  });
});

describe("ExtensionRouter matching", () => {
  test("extracts and decodes params", () => {
    const router = new ExtensionRouter();
    router.add("GET", "/ext/wf/runs/:runId/signal/:event", ok);
    const m = router.match("GET", "/ext/wf/runs/r%201/signal/go");
    expect(m?.params).toEqual({ runId: "r 1", event: "go" });
  });

  test("exposes a trailing wildcard as params['*']", () => {
    const router = new ExtensionRouter();
    router.add("GET", "/ext/files/*", ok);
    expect(router.match("GET", "/ext/files/a/b")?.params).toEqual({ "*": "a/b" });
  });

  test("static segments win over params regardless of registration order", () => {
    const router = new ExtensionRouter();
    router.add("GET", "/ext/wf/:name", ok);
    router.add("GET", "/ext/wf/runs", ok);
    router.add("GET", "/ext/wf/meta/tools", ok);
    expect(router.match("GET", "/ext/wf/runs")?.route.path).toBe("/ext/wf/runs");
    expect(router.match("GET", "/ext/wf/foo")?.route.path).toBe("/ext/wf/:name");
    expect(router.match("GET", "/ext/wf/meta/tools")?.route.path).toBe("/ext/wf/meta/tools");
  });

  test("matches on method (case-insensitive)", () => {
    const router = new ExtensionRouter();
    router.add("POST", "/ext/x/do", ok);
    expect(router.match("post", "/ext/x/do")).not.toBeNull();
    expect(router.match("GET", "/ext/x/do")).toBeNull();
  });

  test("isPublic reflects the route option and is cleared by remove()", () => {
    const router = new ExtensionRouter();
    router.add("GET", "/ext/imap/oauth/callback", ok, { public: true });
    router.add("GET", "/ext/imap/accounts", ok);
    expect(router.isPublic("GET", "/ext/imap/oauth/callback")).toBe(true);
    expect(router.isPublic("POST", "/ext/imap/oauth/callback")).toBe(false);
    expect(router.isPublic("GET", "/ext/imap/accounts")).toBe(false);
    router.remove("GET", "/ext/imap/oauth/callback");
    expect(router.isPublic("GET", "/ext/imap/oauth/callback")).toBe(false);
  });

  test("add() replaces an existing route with the same method and path", () => {
    const router = new ExtensionRouter();
    const first = () => new Response("1");
    const second = () => new Response("2");
    router.add("GET", "/ext/x/y", first);
    router.add("GET", "/ext/x/y", second);
    expect(router.match("GET", "/ext/x/y")?.route.handler).toBe(second);
  });
});

describe("ExtensionRouter dispatch through a live Elysia server", () => {
  const router = new ExtensionRouter();
  const dispatch = (ctx: Context) => router.dispatch(ctx);
  const app = new Elysia()
    .get("/ext/*", dispatch, { parse: "none" })
    .post("/ext/*", dispatch, { parse: "none" })
    .put("/ext/*", dispatch, { parse: "none" })
    .delete("/ext/*", dispatch, { parse: "none" });
  let base = "";

  beforeAll(() => {
    app.listen({ hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${app.server?.port}`;
  });

  afterAll(() => {
    app.stop(true);
  });

  test("routes registered after listen() are served, removed, and replaced", async () => {
    expect((await fetch(`${base}/ext/late/ping`)).status).toBe(404);

    router.add("GET", "/ext/late/ping", () => new Response("v1"));
    expect(await (await fetch(`${base}/ext/late/ping`)).text()).toBe("v1");

    router.remove("GET", "/ext/late/ping");
    expect((await fetch(`${base}/ext/late/ping`)).status).toBe(404);

    router.add("GET", "/ext/late/ping", () => new Response("v2"));
    expect(await (await fetch(`${base}/ext/late/ping`)).text()).toBe("v2");
  });

  test("a route registered as '/' serves the bare extension prefix", async () => {
    router.add("GET", "/ext/workflows/", () => new Response("list"));
    router.add("GET", "/ext/workflows/:name", () => new Response("detail"));
    expect(await (await fetch(`${base}/ext/workflows`)).text()).toBe("list");
    expect(await (await fetch(`${base}/ext/workflows/`)).text()).toBe("list");
    expect(await (await fetch(`${base}/ext/workflows/foo`)).text()).toBe("detail");
  });

  test("passes params, query, headers, and a parsed JSON body", async () => {
    router.add("POST", "/ext/echo/:id", (ctx) =>
      Response.json({ params: ctx.params, query: ctx.query, header: ctx.headers["x-test"], body: ctx.body }),
    );
    const res = await fetch(`${base}/ext/echo/42?a=1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test": "yes" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await res.json()).toEqual({
      params: { id: "42" },
      query: { a: "1" },
      header: "yes",
      body: { hello: "world" },
    });
  });

  test("handlers may still read the raw request after the body was parsed", async () => {
    router.add("POST", "/ext/raw/json", async (ctx) => Response.json(await ctx.request.json()));
    const res = await fetch(`${base}/ext/raw/json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    expect(await res.json()).toEqual({ n: 1 });
  });

  test("parse: 'none' leaves the body unparsed for raw access", async () => {
    router.add(
      "POST",
      "/ext/raw/hmac",
      async (ctx) => Response.json({ body: ctx.body ?? null, raw: await ctx.request.text() }),
      { parse: "none" },
    );
    const res = await fetch(`${base}/ext/raw/hmac`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"sig":"abc"}',
    });
    expect(await res.json()).toEqual({ body: null, raw: '{"sig":"abc"}' });
  });

  test("parses form data into an object", async () => {
    router.add("POST", "/ext/form/submit", (ctx) => Response.json(ctx.body));
    const form = new FormData();
    form.append("a", "1");
    form.append("tag", "x");
    form.append("tag", "y");
    const res = await fetch(`${base}/ext/form/submit`, { method: "POST", body: form });
    expect(await res.json()).toEqual({ a: "1", tag: ["x", "y"] });
  });

  test("malformed JSON yields 400", async () => {
    router.add("PUT", "/ext/bad/json", () => new Response("unreachable"));
    const res = await fetch(`${base}/ext/bad/json`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });

  test("status() helper results from handlers are honoured", async () => {
    router.add("DELETE", "/ext/st/:id", (ctx) => ctx.status(418, { id: ctx.params.id }) as unknown as Response);
    const res = await fetch(`${base}/ext/st/7`, { method: "DELETE" });
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ id: "7" });
  });
});
