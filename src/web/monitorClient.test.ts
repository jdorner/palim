import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "@src/auth";
import { buildAbility } from "@src/auth";
import { QueueMonitor } from "./monitor";

/** A minimal fake WebSocket that records sent payloads and close calls. */
function fakeWs() {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  return {
    ws: {
      send: (p: string) => sent.push(p),
      close: (code?: number, reason?: string) => closed.push({ code, reason }),
    } as never,
    sent,
    closed,
  };
}

/** Builds a resolved principal for a given user id. */
function principal(userId: string, isAdmin = false): ResolvedPrincipal {
  return {
    user: { id: userId, username: userId, roles: [] },
    isAdmin,
    permissions: [],
    ability: buildAbility({ userId, isAdmin, permissions: [] }),
  };
}

describe("QueueMonitor client tracking", () => {
  test("addClient works without a principal (backward compatible) and sends initial_state", () => {
    const monitor = new QueueMonitor([]);
    const client = fakeWs();
    monitor.addClient(client.ws);
    expect(client.sent.length).toBe(1);
    expect(client.sent[0]).toContain("initial_state");
    monitor.removeClient(client.ws);
  });

  test("addClient accepts a principal and broadcast reaches the client", () => {
    const monitor = new QueueMonitor([]);
    const client = fakeWs();
    monitor.addClient(client.ws, principal("u1"));
    client.sent.length = 0;
    monitor.broadcast({ type: "job_removed", jobId: "j1" });
    expect(client.sent.length).toBe(1);
    monitor.removeClient(client.ws);
  });
});

describe("QueueMonitor client revalidation", () => {
  /** Resolver backed by a mutable token -> principal table. */
  function resolver(tokens: Map<string, ResolvedPrincipal>) {
    return { resolveToken: (t: string) => tokens.get(t) ?? null };
  }

  test("closes clients whose token no longer resolves and stops broadcasting to them", () => {
    const tokens = new Map([
      ["tok-a", principal("alice")],
      ["tok-b", principal("bob")],
    ]);
    const monitor = new QueueMonitor([]);
    monitor.setAuthResolver(resolver(tokens));
    const alice = fakeWs();
    const bob = fakeWs();
    monitor.addClient(alice.ws, principal("alice"), "tok-a");
    monitor.addClient(bob.ws, principal("bob"), "tok-b");

    tokens.delete("tok-a"); // logout / revoke / disable
    expect(monitor.revalidateClients()).toBe(1);
    expect(alice.closed).toEqual([{ code: 4001, reason: "Unauthorized" }]);
    expect(bob.closed).toEqual([]);

    alice.sent.length = 0;
    bob.sent.length = 0;
    monitor.broadcast({ type: "job_removed", jobId: "j1" });
    expect(alice.sent.length).toBe(0);
    expect(bob.sent.length).toBe(1);
  });

  test("refreshes the principal of still-valid clients", () => {
    const tokens = new Map([["tok", principal("alice", true)]]);
    const monitor = new QueueMonitor([]);
    monitor.setAuthResolver(resolver(tokens));
    const client = fakeWs();
    monitor.addClient(client.ws, principal("alice", true), "tok");

    const refreshed = principal("alice");
    tokens.set("tok", refreshed);
    expect(monitor.revalidateClients()).toBe(0);
    const clients = (monitor as never as { clients: Map<unknown, { principal: unknown }> }).clients;
    expect(clients.get(client.ws)?.principal).toBe(refreshed);
  });

  test("does not resend initial_state on revalidation", () => {
    const tokens = new Map([["tok", principal("alice", true)]]);
    const monitor = new QueueMonitor([]);
    monitor.setAuthResolver(resolver(tokens));
    const client = fakeWs();
    monitor.addClient(client.ws, principal("alice", true), "tok");

    client.sent.length = 0;
    tokens.set("tok", principal("alice"));
    monitor.revalidateClients();
    expect(client.sent.length).toBe(0);
  });

  test("is a no-op without a resolver and skips clients without a token", () => {
    const monitor = new QueueMonitor([]);
    const client = fakeWs();
    monitor.addClient(client.ws, principal("alice"), "tok");
    expect(monitor.revalidateClients()).toBe(0);

    monitor.setAuthResolver(resolver(new Map()));
    const tokenless = fakeWs();
    monitor.addClient(tokenless.ws, principal("bob"));
    expect(monitor.revalidateClients()).toBe(1);
    expect(tokenless.closed).toEqual([]);
  });
});
