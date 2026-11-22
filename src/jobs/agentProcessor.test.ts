/**
 * Tests for cancelling {@link runAgent} through the job's abort signal: the
 * in-flight LLM request is aborted and the run throws the abort reason.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import type { QueueJob } from "@src/queue";
import { SessionStore, setSessionStoreForTests } from "@src/session";
import { runAgent } from "./agentProcessor";

/** A fake OpenAI endpoint that accepts every request and never answers it. */
let server: ReturnType<typeof Bun.serve>;
/** Resolvers waiting for the next LLM request to arrive. */
let requestArrived: (() => void)[] = [];
/** Requests whose client went away (the abort reached the network). */
let requestsAborted = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      for (const resolve of requestArrived) resolve();
      requestArrived = [];
      req.signal.addEventListener("abort", () => requestsAborted++, { once: true });
      // Hold the request open until the client aborts it.
      return new Promise<Response>(() => {});
    },
  });
});

afterAll(() => {
  server.stop(true);
});

let ctx: TestDb;
let sessions: SessionStore;

beforeEach(() => {
  ctx = createTestDb();
  sessions = new SessionStore(ctx.db);
  setSessionStoreForTests(sessions);
  requestsAborted = 0;
});

afterEach(() => {
  setSessionStoreForTests(null);
  ctx.sqlite.close();
});

/** A model pointing at the fake endpoint. */
function fakeModel(): Model<"openai-completions"> {
  return {
    id: "fake",
    name: "fake",
    api: "openai-completions",
    provider: "openai",
    baseUrl: `http://localhost:${server.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
    compat: { supportsDeveloperRole: false },
  };
}

/** A job with an abort controller and recorded logs. */
function fakeJob() {
  const controller = new AbortController();
  const logs: string[] = [];
  const job: QueueJob<unknown> = {
    id: "job-1",
    name: "test",
    data: {},
    attemptsMade: 0,
    signal: controller.signal,
    log: async (message) => {
      logs.push(message);
    },
  };
  return { job, controller, logs };
}

describe("runAgent cancellation", () => {
  test("aborting the job's signal mid-request fails the run with the reason", async () => {
    const session = sessions.create({ source: "test", sourceId: "cancel-mid-request" });
    sessions.append(session.id, { role: "user", content: "Hello", timestamp: Date.now() });
    const { job, controller, logs } = fakeJob();
    const arrived = new Promise<void>((resolve) => requestArrived.push(resolve));

    const run = runAgent(job, {
      model: fakeModel(),
      tools: [],
      apiKey: "test",
      systemPrompt: "Test",
      sessionId: session.id,
    });
    await arrived;
    controller.abort(new Error("Cancelled by alice"));

    await expect(run).rejects.toThrow("Cancelled by alice");
    expect(logs.at(-1)).toBe("**Error:** Cancelled by alice");
    // The request itself was aborted, not left running in the background.
    await Bun.sleep(20);
    expect(requestsAborted).toBe(1);
    // A cancelled run appends nothing to the session.
    expect(sessions.getMessages(session.id)).toHaveLength(1);
  });

  test("an already aborted signal fails the run before any LLM request", async () => {
    const session = sessions.create({ source: "test", sourceId: "cancel-before-start" });
    sessions.append(session.id, { role: "user", content: "Hello", timestamp: Date.now() });
    const { job, controller, logs } = fakeJob();
    controller.abort(new Error("Cancelled by bob"));
    let requested = false;
    requestArrived.push(() => {
      requested = true;
    });

    await expect(
      runAgent(job, { model: fakeModel(), tools: [], apiKey: "test", systemPrompt: "Test", sessionId: session.id }),
    ).rejects.toThrow("Cancelled by bob");
    expect(logs.at(-1)).toBe("**Error:** Cancelled by bob");
    expect(requested).toBe(false);
    requestArrived = [];
  });
});
