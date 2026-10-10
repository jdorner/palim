/**
 * Tests for the portal API: human task routes, their authorization, and the
 * server-sent event stream.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BUILT_IN_ROLES, PERMISSIONS, ROLE_ADMIN, ROLE_PORTAL_USER, ROLE_USER } from "@shared/auth";
import type { HumanTask, PortalEvent } from "@shared/portal";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { type CreateTaskInput, createHitlService, createUserDirectory, type HitlService, TaskStore } from "@src/hitl";
import { Elysia } from "elysia";
import { PortalEventHub } from "./portalEvents";
import { authRoutes } from "./routes/auth";
import { portalRoutes } from "./routes/portal";
import { authCheck } from "./server";

describe("portal API", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;
  let service: HitlService;
  let hub: PortalEventHub;
  let app: ReturnType<typeof buildApp>;

  function buildApp() {
    return new Elysia()
      .onBeforeHandle((c) => authCheck(c as never, auth))
      .use(authRoutes(() => auth))
      .use(
        portalRoutes(
          () => service,
          () => hub,
        ),
      );
  }

  async function seed(username: string, kind: "operator" | "portal", roleNames: string[]): Promise<void> {
    const user = store.createUser({ username, passwordHash: await auth.hashPassword("pw"), kind });
    store.setUserRoles(
      user.id,
      roleNames.map((n) => store.getRoleByName(n)!.id),
    );
  }

  async function login(username: string): Promise<string> {
    return (await auth.login(username, "pw"))?.token ?? "";
  }

  function req(method: string, path: string, token: string, body?: unknown): Request {
    return new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  function task(overrides: Partial<CreateTaskInput> = {}) {
    return service.createTask({
      source: { kind: "workflow", id: "run-1", ref: { runId: "run-1", stepSlug: "review", signalId: "s" } },
      title: "Approve invoice",
      assignees: { users: ["pat"] },
      ...overrides,
    });
  }

  beforeEach(async () => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    for (const def of Object.values(BUILT_IN_ROLES)) {
      const role = store.createRole(def.name, def.description, true);
      if (def.permissions) store.setRolePermissions(role.id, def.permissions);
    }
    const chatOnly = store.createRole("chatters", undefined, false);
    store.setRolePermissions(chatOnly.id, [PERMISSIONS.CHAT_WRITE]);
    await seed("root", "operator", [ROLE_ADMIN]);
    await seed("alice", "operator", [ROLE_USER]);
    await seed("pat", "portal", [ROLE_PORTAL_USER]);
    await seed("carol", "operator", ["chatters"]);
    service = createHitlService({ store: new TaskStore(ctx.db as never), directory: createUserDirectory(store) });
    hub = new PortalEventHub(service, auth);
    app = buildApp();
  });

  afterEach(() => {
    hub.close();
    ctx.sqlite.close();
  });

  describe("task routes", () => {
    test("lists the caller's tasks and their counts", async () => {
      const created = task({ dueAt: Date.now() + 60_000 });
      task({ assignees: { users: ["alice"] } });
      const token = await login("pat");

      const list = await app.handle(req("GET", "/api/portal/tasks", token));
      expect(list.status).toBe(200);
      const body = (await list.json()) as { tasks: HumanTask[]; nextCursor: string | null };
      expect(body.tasks.map((t) => t.id)).toEqual([created.id]);
      expect(body.tasks[0]!.canRespond).toBe(true);
      expect(body.tasks[0]!.source).toEqual({ kind: "workflow" });

      const counts = await app.handle(req("GET", "/api/portal/tasks/counts", token));
      expect(await counts.json()).toEqual({ open: 1, dueSoon: 1 });
    });

    test("an account without hitl permissions gets 403", async () => {
      const token = await login("carol");
      expect((await app.handle(req("GET", "/api/portal/tasks", token))).status).toBe(403);
      expect((await app.handle(req("GET", "/api/portal/events", token))).status).toBe(403);
    });

    test("rejects an invalid status filter", async () => {
      const token = await login("pat");
      expect((await app.handle(req("GET", "/api/portal/tasks?status=done", token))).status).toBe(400);
    });

    test("detail of a task the caller may not see answers 404", async () => {
      const hidden = task({ assignees: { users: ["alice"] } });
      const token = await login("pat");
      expect((await app.handle(req("GET", `/api/portal/tasks/${hidden.id}`, token))).status).toBe(404);
    });

    test("answers a task once; validation errors keep it open", async () => {
      const created = task({ requireComment: true });
      const token = await login("pat");

      const invalid = await app.handle(
        req("POST", `/api/portal/tasks/${created.id}/complete`, token, { outcome: "approve" }),
      );
      expect(invalid.status).toBe(422);

      const ok = await app.handle(
        req("POST", `/api/portal/tasks/${created.id}/complete`, token, {
          outcome: "approve",
          comment: "looks good",
          version: created.version,
        }),
      );
      expect(ok.status).toBe(200);
      const { task: done } = (await ok.json()) as { task: HumanTask };
      expect(done.completion).toMatchObject({ outcome: "approve", comment: "looks good", by: { username: "pat" } });

      const again = await app.handle(
        req("POST", `/api/portal/tasks/${created.id}/complete`, token, { outcome: "reject", comment: "x" }),
      );
      expect(again.status).toBe(409);
    });

    test("cancel and reassign need hitl:manage", async () => {
      const created = task();
      const pat = await login("pat");
      const root = await login("root");

      expect((await app.handle(req("POST", `/api/portal/tasks/${created.id}/cancel`, pat, {}))).status).toBe(403);
      expect(
        (await app.handle(req("PATCH", `/api/portal/tasks/${created.id}/assignees`, pat, { users: ["pat"] }))).status,
      ).toBe(403);

      const reassigned = await app.handle(
        req("PATCH", `/api/portal/tasks/${created.id}/assignees`, root, { users: ["alice"] }),
      );
      expect(reassigned.status).toBe(200);
      const cancelled = await app.handle(
        req("POST", `/api/portal/tasks/${created.id}/cancel`, root, { reason: "duplicate" }),
      );
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as { task: HumanTask }).task.status).toBe("cancelled");
    });

    test("me returns the portal URL (null when unset)", async () => {
      const token = await login("pat");
      const me = (await (await app.handle(req("GET", "/api/auth/me", token))).json()) as { portalUrl: unknown };
      expect(me.portalUrl).toBeNull();
    });
  });

  describe("event stream", () => {
    /** Opens a stream and returns a reader yielding parsed events. */
    async function openStream(username: string) {
      const res = await app.handle(req("GET", "/api/portal/events", await login(username)));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/event-stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      return {
        /** Reads the next event (skips heartbeats). */
        async next(): Promise<PortalEvent> {
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end !== -1) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = frame.split("\n").find((l) => l.startsWith("data: "));
              if (data) return JSON.parse(data.slice(6)) as PortalEvent;
              continue;
            }
            const { value, done } = await reader.read();
            if (done) throw new Error("stream closed");
            buffer += decoder.decode(value);
          }
        },
        cancel: () => reader.cancel(),
      };
    }

    test("starts with the counts and delivers task changes to the people who can see them", async () => {
      const pat = await openStream("pat");
      const alice = await openStream("alice");
      expect(await pat.next()).toEqual({ type: "ready", counts: { open: 0, dueSoon: 0 } });
      expect((await alice.next()).type).toBe("ready");

      const created = task();
      const patCreated = await pat.next();
      expect(patCreated).toMatchObject({ type: "task_created", task: { id: created.id }, counts: { open: 1 } });

      // Reassigning moves the task from pat to alice; alice never saw it before.
      const root = await login("root");
      await app.handle(req("PATCH", `/api/portal/tasks/${created.id}/assignees`, root, { users: ["alice"] }));
      expect(await pat.next()).toEqual({ type: "task_removed", taskId: created.id, counts: { open: 0, dueSoon: 0 } });
      expect(await alice.next()).toMatchObject({ type: "task_created", task: { id: created.id } });

      await app.handle(
        req("POST", `/api/portal/tasks/${created.id}/complete`, await login("alice"), { outcome: "approve" }),
      );
      expect(await alice.next()).toMatchObject({
        type: "task_updated",
        task: { id: created.id, status: "completed" },
        counts: { open: 0 },
      });

      await pat.cancel();
      await alice.cancel();
    });

    test("closes the stream when the token is revoked", async () => {
      const token = await login("pat");
      const res = await app.handle(req("GET", "/api/portal/events", token));
      const reader = res.body!.getReader();
      await reader.read(); // ready

      await auth.logout(token);
      task();

      expect((await reader.read()).done).toBe(true);
      expect(hub.size).toBe(0);
    });
  });
});
