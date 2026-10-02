import { describe, expect, test } from "bun:test";
import type { JobEntry } from "@shared/types";
import type { ResolvedPrincipal } from "@src/auth";
import { buildAbility } from "@src/auth";
import { QueueMonitor } from "./monitor";

/** A minimal fake WebSocket capturing parsed messages. */
function fakeWs() {
  const messages: { type: string; jobs?: JobEntry[]; job?: JobEntry; jobId?: string }[] = [];
  return {
    ws: { send: (p: string) => messages.push(JSON.parse(p)) } as never,
    messages,
  };
}

/** Builds a principal for a given user id / admin flag. */
function principal(userId: string, isAdmin = false): ResolvedPrincipal {
  return {
    user: { id: userId, username: userId, roles: [] },
    isAdmin,
    permissions: [],
    ability: buildAbility({ userId, isAdmin, permissions: [] }),
  };
}

/** Builds a job entry with an optional owner. */
function job(id: string, userId?: string): JobEntry {
  return {
    id,
    description: id,
    queue: "agents",
    status: "active",
    createdAt: Date.now(),
    ...(userId ? { userId } : {}),
  };
}

describe("QueueMonitor job broadcasts", () => {
  test("job events owned by any user are delivered to every client", () => {
    const monitor = new QueueMonitor([]);
    const client = fakeWs();
    monitor.addClient(client.ws, principal("alice"));
    client.messages.length = 0;

    monitor.broadcast({ type: "job_added", job: job("j1", "bob") });
    monitor.broadcast({ type: "job_updated", job: job("j1", "bob") });
    monitor.broadcast({ type: "job_added", job: job("j2") });
    monitor.broadcast({ type: "job_removed", jobId: "j1" });
    expect(client.messages.map((m) => m.type)).toEqual(["job_added", "job_updated", "job_added", "job_removed"]);
  });

  test("initial_state includes other users' jobs", () => {
    const monitor = new QueueMonitor([]);
    const cache = (monitor as never as { jobCache: Map<string, JobEntry> }).jobCache;
    cache.set("j1", job("j1", "bob"));
    const client = fakeWs();
    monitor.addClient(client.ws, principal("alice"));
    const initial = client.messages.find((m) => m.type === "initial_state");
    expect(initial?.jobs?.map((j) => j.id)).toEqual(["j1"]);
  });

  test("global (non-job) events are delivered to every authenticated client", () => {
    const monitor = new QueueMonitor([]);
    const client = fakeWs();
    monitor.addClient(client.ws, principal("alice"));
    client.messages.length = 0;

    monitor.broadcast({ type: "webhooks_reload" });
    monitor.broadcast({ type: "filewatcher_reload" });
    expect(client.messages.length).toBe(2);
  });

  test("an empty initial_state is sent to a connecting client", () => {
    const monitor = new QueueMonitor([]);
    const client = fakeWs();
    monitor.addClient(client.ws, principal("alice"));
    const initial = client.messages.find((m) => m.type === "initial_state");
    expect(initial).toBeDefined();
    expect(initial?.jobs).toEqual([]);
  });
});

describe("QueueMonitor chat stream scoping", () => {
  /** Connects alice, bob and an admin, clearing their initial_state messages. */
  function setup() {
    const monitor = new QueueMonitor([]);
    const alice = fakeWs();
    const bob = fakeWs();
    const admin = fakeWs();
    monitor.addClient(alice.ws, principal("alice"));
    monitor.addClient(bob.ws, principal("bob"));
    monitor.addClient(admin.ws, principal("root", true));
    for (const c of [alice, bob, admin]) c.messages.length = 0;
    return { monitor, alice, bob, admin };
  }

  test("chat_event is delivered only to the chat owner, not to other users or admins", () => {
    const { monitor, alice, bob, admin } = setup();
    monitor.registerChatOwner("chat-1", "alice");

    monitor.broadcast({ type: "chat_event", chatId: "chat-1", event: "text_delta", content: "secret" });
    expect(alice.messages.length).toBe(1);
    expect(bob.messages.length).toBe(0);
    expect(admin.messages.length).toBe(0);
  });

  test("an admin receives their own chat stream", () => {
    const { monitor, admin } = setup();
    monitor.registerChatOwner("chat-admin", "root");

    monitor.broadcast({ type: "chat_event", chatId: "chat-admin", event: "text_delta", content: "a" });
    expect(admin.messages.length).toBe(1);
  });

  test("push_message is delivered only to the chat owner", () => {
    const { monitor, alice, bob, admin } = setup();
    monitor.registerChatOwner("chat-1", "alice");

    monitor.broadcast({ type: "push_message", chatId: "chat-1", content: "hi", contentType: "text/plain" });
    expect(alice.messages.length).toBe(1);
    expect(bob.messages.length).toBe(0);
    expect(admin.messages.length).toBe(0);
  });

  test("chat events for unknown or ownerless chats reach no one", () => {
    const { monitor, alice, admin } = setup();
    monitor.registerChatOwner("chat-orphan", null);

    monitor.broadcast({ type: "chat_event", chatId: "chat-unknown", event: "error", error: "x" });
    monitor.broadcast({ type: "chat_event", chatId: "chat-orphan", event: "done", content: "x" });
    expect(alice.messages.length).toBe(0);
    expect(admin.messages.length).toBe(0);
  });

  test("a later claim on an existing chatId cannot hijack the stream", () => {
    const { monitor, alice, bob } = setup();
    monitor.registerChatOwner("chat-1", "alice");
    monitor.registerChatOwner("chat-1", "bob");

    monitor.broadcast({ type: "chat_event", chatId: "chat-1", event: "tool_start", toolName: "bash" });
    expect(alice.messages.length).toBe(1);
    expect(bob.messages.length).toBe(0);
  });

  test("chat ownership is learned from queued chat jobs and dropped on eviction", async () => {
    const handlers: Record<string, (e: { jobId: string; job: unknown }) => void> = {};
    const chatJob = {
      id: "job-1",
      name: "chat-1",
      state: "waiting",
      timestamp: Date.now(),
      data: { context: { source: "chat", id: "chat-1" }, initiatorUserId: "alice" },
    };
    const queue = {
      name: "chat",
      onEvent: (event: string, handler: (e: { jobId: string; job: unknown }) => void) => {
        handlers[event] = handler;
      },
      getAllJobs: async () => [],
      getJob: async () => chatJob,
    } as never;
    const monitor = new QueueMonitor([queue]);
    const alice = fakeWs();
    const bob = fakeWs();
    monitor.addClient(alice.ws, principal("alice"));
    monitor.addClient(bob.ws, principal("bob"));

    await handlers.waiting?.({ jobId: "job-1", job: chatJob });
    alice.messages.length = 0;
    bob.messages.length = 0;

    monitor.broadcast({ type: "chat_event", chatId: "chat-1", event: "text_delta", content: "a" });
    expect(alice.messages.length).toBe(1);
    expect(bob.messages.length).toBe(0);

    monitor.removeJobs(["job-1"]);
    alice.messages.length = 0;
    monitor.broadcast({ type: "chat_event", chatId: "chat-1", event: "text_delta", content: "b" });
    expect(alice.messages.length).toBe(0);
  });
});

describe("QueueMonitor chat job scoping", () => {
  /** Builds a raw queue job; chat jobs carry a chat routing context. */
  function rawJob(id: string, opts: { chat?: boolean; owner?: string } = {}) {
    return {
      id,
      name: id,
      state: "waiting",
      timestamp: Date.now(),
      data: {
        ...(opts.chat ? { context: { source: "chat", id: `chat-${id}` } } : {}),
        ...(opts.owner ? { initiatorUserId: opts.owner } : {}),
      },
    };
  }

  /** Fake queue holding the given raw jobs, exposing its event handlers. */
  function fakeQueue(name: string, jobs: ReturnType<typeof rawJob>[]) {
    const handlers: Record<string, (e: { jobId: string; job: unknown }) => Promise<void> | void> = {};
    const queue = {
      name,
      onEvent: (event: string, handler: (e: { jobId: string; job: unknown }) => void) => {
        handlers[event] = handler;
      },
      getAllJobs: async () => jobs,
      getJob: async (id: string) => jobs.find((j) => j.id === id) ?? null,
    } as never;
    return { queue, handlers };
  }

  /** Monitor over a chat queue (alice's and an ownerless chat job) and an agents queue (bob's job). */
  async function setup() {
    const chat = fakeQueue("chat", [
      rawJob("c-alice", { chat: true, owner: "alice" }),
      rawJob("c-orphan", { chat: true }),
    ]);
    const agents = fakeQueue("agents", [rawJob("a-bob", { owner: "bob" })]);
    const monitor = new QueueMonitor([]);
    await monitor.addQueues([chat.queue, agents.queue]);
    const alice = fakeWs();
    const bob = fakeWs();
    const admin = fakeWs();
    monitor.addClient(alice.ws, principal("alice"));
    monitor.addClient(bob.ws, principal("bob"));
    monitor.addClient(admin.ws, principal("root", true));
    return { monitor, chat, alice, bob, admin };
  }

  /** Job ids in a client's most recent initial_state. */
  function snapshotIds(client: ReturnType<typeof fakeWs>): string[] | undefined {
    return client.messages
      .filter((m) => m.type === "initial_state")
      .at(-1)
      ?.jobs?.map((j) => j.id)
      .sort();
  }

  test("initial_state shows chat jobs only to their initiator, admins included", async () => {
    const { alice, bob, admin } = await setup();
    expect(snapshotIds(alice)).toEqual(["a-bob", "c-alice"]);
    expect(snapshotIds(bob)).toEqual(["a-bob"]);
    expect(snapshotIds(admin)).toEqual(["a-bob"]);
  });

  test("job_added, job_updated and job_log for a chat job reach only its initiator", async () => {
    const { monitor, chat, alice, bob, admin } = await setup();
    for (const c of [alice, bob, admin]) c.messages.length = 0;

    await chat.handlers.waiting?.({ jobId: "c-new", job: rawJob("c-new", { chat: true, owner: "alice" }) });
    await chat.handlers.active?.({ jobId: "c-new", job: null });
    monitor.broadcast({ type: "job_log", jobId: "c-new", log: { timestamp: Date.now(), message: "x" } });

    expect(alice.messages.map((m) => m.type)).toEqual(["job_added", "job_updated", "job_log"]);
    expect(bob.messages).toEqual([]);
    expect(admin.messages).toEqual([]);
  });

  test("job_removed for a chat job reaches only its initiator; other removals reach everyone", async () => {
    const { monitor, alice, bob } = await setup();
    alice.messages.length = 0;
    bob.messages.length = 0;

    monitor.broadcast({ type: "job_removed", jobId: "c-alice" });
    monitor.broadcast({ type: "job_removed", jobId: "a-bob" });
    expect(alice.messages.map((m) => m.jobId)).toEqual(["c-alice", "a-bob"]);
    expect(bob.messages.map((m) => m.jobId)).toEqual(["a-bob"]);
  });

  test("full-state rebroadcasts are scoped per client", async () => {
    const { monitor, alice, bob } = await setup();
    monitor.removeJobs(["a-bob"]);
    expect(snapshotIds(alice)).toEqual(["c-alice"]);
    expect(snapshotIds(bob)).toEqual([]);
  });

  test("canAccessJob limits chat jobs to their initiator and leaves other jobs open", async () => {
    const { monitor } = await setup();
    expect(await monitor.canAccessJob("c-alice", principal("alice"))).toBe(true);
    expect(await monitor.canAccessJob("c-alice", principal("bob"))).toBe(false);
    expect(await monitor.canAccessJob("c-alice", principal("root", true))).toBe(false);
    expect(await monitor.canAccessJob("c-orphan", principal("alice"))).toBe(false);
    expect(await monitor.canAccessJob("a-bob", principal("alice"))).toBe(true);
    expect(await monitor.canAccessJob("missing", principal("alice"))).toBe(true);
  });

  test("canAccessJob falls back to the queues for uncached jobs", async () => {
    const { monitor } = await setup();
    const cache = (monitor as never as { jobCache: Map<string, JobEntry> }).jobCache;
    cache.clear();
    expect(await monitor.canAccessJob("c-alice", principal("alice"))).toBe(true);
    expect(await monitor.canAccessJob("c-alice", principal("bob"))).toBe(false);
    expect(await monitor.canAccessJob("a-bob", principal("alice"))).toBe(true);
  });
});
