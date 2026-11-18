import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionContext, StepExecutionContext, StepTypeHandler } from "@ext/types";
import { InMemoryFs } from "just-bash";
import { createExtension } from "./index";

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with a stub that records each request and answers 200. */
function captureFetch(): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    // Building a real Request applies the same header validation fetch does,
    // so a non-ByteString header value would throw here as it does in production.
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: (await request.json()) as Record<string, unknown> });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return requests;
}

/**
 * Initializes a fresh ntfy extension and returns its notify-ntfy step handler.
 *
 * @param options - Server setting and secrets to expose through the fake context
 * @returns The registered step handler
 */
async function initStep(options: { server?: string; secrets?: Record<string, string> } = {}) {
  let handler: StepTypeHandler | undefined;
  const ctx = {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    config: { get: (key: string) => (key === "SERVER" ? options.server : undefined) },
    secrets: { get: async (key: string) => options.secrets?.[key] ?? null },
    stepTypes: { register: (_type: string, h: StepTypeHandler) => (handler = h) },
    events: { on: () => {} },
  } as unknown as ExtensionContext;
  await createExtension().initialize(ctx);
  if (!handler) throw new Error("notify-ntfy step was not registered");
  return handler;
}

const stepCtx = {
  resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  workDir: "/tmp/test-work",
  fs: new InMemoryFs(),
  jobLog: async () => {},
  workflowRunId: "test-run",
} as unknown as StepExecutionContext;

describe("ntfy publish", () => {
  test("publishes all fields as JSON to the server root", async () => {
    const requests = captureFetch();
    const step = await initStep({ server: "https://ntfy.example.com", secrets: { NTFY_ACCESS_TOKEN: "tk_1" } });

    await step.execute(
      {
        slug: "n",
        type: "notify-ntfy",
        topic: "alerts",
        title: "Build done",
        message: "All green",
        click: "https://example.com/run/1",
        markdown: true,
        priority: "4",
        tags: ["white_check_mark", "ci"],
      },
      stepCtx,
    );

    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req?.url).toBe("https://ntfy.example.com/");
    expect(req?.headers.get("content-type")).toBe("application/json");
    expect(req?.headers.get("authorization")).toBe("Bearer tk_1");
    expect(req?.body).toEqual({
      topic: "alerts",
      title: "Build done",
      message: "All green",
      click: "https://example.com/run/1",
      markdown: true,
      priority: 4,
      tags: ["white_check_mark", "ci"],
    });
  });

  test("sends non-ASCII title, tags and click URL unchanged", async () => {
    const requests = captureFetch();
    const step = await initStep({ secrets: { NTFY_DEFAULT_TOPIC: "default-topic" } });

    await step.execute(
      {
        slug: "n",
        type: "notify-ntfy",
        title: "🚀 Größe geändert",
        message: "Läuft ✅",
        click: "https://example.com/straße",
        tags: ["müll"],
      },
      stepCtx,
    );

    expect(requests[0]?.url).toBe("https://ntfy.sh/");
    expect(requests[0]?.body).toEqual({
      topic: "default-topic",
      title: "🚀 Größe geändert",
      message: "Läuft ✅",
      click: "https://example.com/straße",
      tags: ["müll"],
    });
  });

  test("omits unset optional fields and keeps a server path prefix", async () => {
    const requests = captureFetch();
    const step = await initStep({ server: "https://host.example/ntfy" });

    await step.execute({ slug: "n", type: "notify-ntfy", topic: "t", message: "hi" }, stepCtx);

    expect(requests[0]?.url).toBe("https://host.example/ntfy/");
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    expect(requests[0]?.body).toEqual({ topic: "t", message: "hi" });
  });

  test("surfaces the server's error response", async () => {
    globalThis.fetch = (async () =>
      new Response("topic invalid", { status: 400, statusText: "Bad Request" })) as unknown as typeof fetch;
    const step = await initStep();

    await expect(step.execute({ slug: "n", type: "notify-ntfy", topic: "t", message: "hi" }, stepCtx)).rejects.toThrow(
      "ntfy publish failed (400 Bad Request): topic invalid",
    );
  });
});
