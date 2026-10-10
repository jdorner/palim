/**
 * Tests for the HITL task store and service.
 *
 * Uses an in-memory SQLite database with all migrations applied.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { HumanTaskUserRef } from "@shared/portal";
import { createTestDb } from "@src/test/db";
import {
  type CreateTaskInput,
  createHitlService,
  type HitlChange,
  type HitlDirectory,
  HitlError,
  type HitlService,
  type HitlViewer,
} from "./hitlService";
import { type TaskRecord, TaskStore } from "./taskStore";

const USERS: Record<string, HumanTaskUserRef> = {
  "u-alice": { id: "u-alice", username: "alice", displayName: "Alice" },
  "u-bob": { id: "u-bob", username: "bob", displayName: null },
  "u-carol": { id: "u-carol", username: "carol", displayName: null },
  "u-admin": { id: "u-admin", username: "admin", displayName: null },
};
const ROLES = new Set(["accounting", "user", "admin"]);

const directory: HitlDirectory = {
  findUserIdByUsername: (username) => Object.values(USERS).find((u) => u.username === username)?.id ?? null,
  roleExists: (name) => ROLES.has(name),
  describeUser: (id) => USERS[id] ?? null,
};

const alice: HitlViewer = { userId: "u-alice", roleNames: ["user"], canManage: false };
const bob: HitlViewer = { userId: "u-bob", roleNames: ["accounting"], canManage: false };
const carol: HitlViewer = { userId: "u-carol", roleNames: ["user"], canManage: false };
const admin: HitlViewer = { userId: "u-admin", roleNames: ["admin"], canManage: true };

let clock = 1_000_000;
let store: TaskStore;
let service: HitlService;
let changes: HitlChange[];

/** Builds a valid task input with overrides. */
function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    source: { kind: "workflow", id: "run-1", ref: { runId: "run-1", stepSlug: "review", signalId: "sig-1" } },
    title: "Approve invoice 42",
    assignees: { users: ["alice"], roles: ["accounting"] },
    ...overrides,
  };
}

/** Asserts that a call throws a HitlError with the given status. */
async function expectStatus(fn: () => unknown, status: HitlError["status"]) {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HitlError);
    expect((err as HitlError).status).toBe(status);
    return err as HitlError;
  }
  throw new Error(`expected HitlError ${status}`);
}

beforeEach(() => {
  clock = 1_000_000;
  store = new TaskStore(createTestDb() as never);
  service = createHitlService({ store, directory, now: () => clock });
  changes = [];
  service.subscribe((c) => changes.push(c));
});

describe("createTask", () => {
  test("stores the task with defaults, resolved assignees, and a created entry", () => {
    const task = service.createTask(input({ createdBy: "u-admin" }));

    expect(task.status).toBe("open");
    expect(task.outcomes.map((o) => o.id)).toEqual(["approve", "reject"]);
    expect(task.priority).toBe("normal");
    expect(task.assignees).toEqual({ users: ["u-alice"], roles: ["accounting"] });
    expect(task.source.ref).toEqual({ runId: "run-1", stepSlug: "review", signalId: "sig-1" });
    expect(task.version).toBe(1);
    expect(store.listEvents(task.id).map((e) => e.kind)).toEqual(["created"]);
    expect(changes).toEqual([{ type: "created", task }]);
  });

  test("rejects unknown users and roles", async () => {
    const err = await expectStatus(
      () => service.createTask(input({ assignees: { users: ["nobody"], roles: ["ghosts"] } })),
      400,
    );
    expect(err.message).toContain("nobody");
    expect(err.message).toContain("ghosts");
  });

  test("requires at least one assignee", async () => {
    await expectStatus(() => service.createTask(input({ assignees: {} })), 400);
  });

  test("rejects invalid input and duplicate outcome IDs", async () => {
    await expectStatus(() => service.createTask(input({ title: "" })), 400);
    await expectStatus(
      () =>
        service.createTask(
          input({
            outcomes: [
              { id: "ok", label: "OK" },
              { id: "ok", label: "Also OK" },
            ],
          }),
        ),
      400,
    );
    await expectStatus(() => service.createTask(input({ outcomes: [{ id: "Bad Id", label: "x" }] })), 400);
  });
});

describe("visibility", () => {
  test("assignees see tasks directly and via roles; others get 404", async () => {
    const task = service.createTask(input());

    expect(service.getTask(task.id, alice).canRespond).toBe(true);
    expect(service.getTask(task.id, bob).canRespond).toBe(true);
    await expectStatus(() => service.getTask(task.id, carol), 404);
    expect(service.getTask(task.id, admin).canRespond).toBe(true);
  });

  test("listTasks(mine) returns only visible tasks, newest first", () => {
    const a = service.createTask(input({ title: "for alice", assignees: { users: ["alice"] } }));
    clock++;
    const b = service.createTask(input({ title: "for accounting", assignees: { roles: ["accounting"] } }));
    clock++;
    const c = service.createTask(input({ title: "for both", assignees: { users: ["alice"], roles: ["accounting"] } }));

    expect(service.listTasks(alice).tasks.map((t) => t.id)).toEqual([c.id, a.id]);
    expect(service.listTasks(bob).tasks.map((t) => t.id)).toEqual([c.id, b.id]);
    expect(service.listTasks(carol).tasks).toEqual([]);
  });

  test("scope all requires manage rights", async () => {
    service.createTask(input());
    await expectStatus(() => service.listTasks(alice, { scope: "all" }), 403);
    expect(service.listTasks(admin, { scope: "all" }).tasks).toHaveLength(1);
  });

  test("source references are only shown to managers", () => {
    const task = service.createTask(input());

    expect(service.getTask(task.id, alice).source).toEqual({ kind: "workflow" });
    expect(service.getTask(task.id, admin).source.ref).toEqual({
      runId: "run-1",
      stepSlug: "review",
      signalId: "sig-1",
    });
  });

  test("a non-assignee who completed a task (after reassignment) still sees it but cannot respond", async () => {
    const task = service.createTask(input({ assignees: { users: ["alice"] } }));
    await service.completeTask(task.id, alice, { outcome: "approve" });
    // Assignment changes do not apply to completed tasks, so simulate a lost role.
    const aliceWithoutAssignment: HitlViewer = { ...alice, userId: "u-alice", roleNames: [] };

    const seen = service.getTask(task.id, aliceWithoutAssignment);
    expect(seen.status).toBe("completed");
    expect(seen.canRespond).toBe(false);
  });

  test("paginates with a cursor", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.unshift(service.createTask(input({ title: `t${i}` })).id);
      clock++;
    }

    const first = service.listTasks(alice, { limit: 2 });
    const second = service.listTasks(alice, { limit: 2, cursor: first.nextCursor! });
    const third = service.listTasks(alice, { limit: 2, cursor: second.nextCursor! });

    expect([...first.tasks, ...second.tasks, ...third.tasks].map((t) => t.id)).toEqual(ids);
    expect(third.nextCursor).toBeNull();
  });

  test("rejects a malformed cursor", async () => {
    await expectStatus(() => service.listTasks(alice, { cursor: "garbage" }), 400);
  });
});

describe("getTask", () => {
  test("records the first view of an assignee once", () => {
    const task = service.createTask(input());

    service.getTask(task.id, alice);
    service.getTask(task.id, alice);
    const detail = service.getTask(task.id, bob);

    expect(detail.history.map((h) => [h.kind, h.actor?.username ?? null])).toEqual([
      ["created", null],
      ["viewed", "alice"],
      ["viewed", "bob"],
    ]);
  });
});

describe("completeTask", () => {
  test("completes, records the answer, notifies, and calls the source", async () => {
    const completed: TaskRecord[] = [];
    service.registerSourceHandler("workflow", { onCompleted: (t) => void completed.push(t) });
    const task = service.createTask(
      input({ form: { type: "object", properties: { costCenter: { type: "string" } } } }),
    );
    clock = 2_000_000;

    const result = await service.completeTask(task.id, bob, {
      outcome: "approve",
      data: { costCenter: "CC-7" },
      comment: "  fine  ",
      version: task.version,
    });

    expect(result.status).toBe("completed");
    expect(result.canRespond).toBe(false);
    expect(result.completion).toEqual({
      at: 2_000_000,
      by: USERS["u-bob"]!,
      outcome: "approve",
      data: { costCenter: "CC-7" },
      comment: "fine",
    });
    expect(result.version).toBe(2);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.outcome).toBe("approve");
    expect(changes.map((c) => c.type)).toEqual(["created", "updated"]);
  });

  test("the first responder wins; a second answer gets 409", async () => {
    const task = service.createTask(input());

    await service.completeTask(task.id, alice, { outcome: "approve" });
    await expectStatus(() => service.completeTask(task.id, bob, { outcome: "reject" }), 409);
  });

  test("a stale version is rejected with 409", async () => {
    const task = service.createTask(input());
    service.reassignTask(task.id, admin, { users: ["alice", "bob"] });

    const err = await expectStatus(
      () => service.completeTask(task.id, alice, { outcome: "approve", version: task.version }),
      409,
    );
    expect(err.message).toContain("changed");
  });

  test("validates outcome, comment, and form data", async () => {
    const task = service.createTask(
      input({
        requireComment: true,
        form: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
      }),
    );

    await expectStatus(() => service.completeTask(task.id, alice, { outcome: "maybe", comment: "x" }), 422);
    await expectStatus(
      () => service.completeTask(task.id, alice, { outcome: "approve", comment: " ", data: { amount: 1 } }),
      422,
    );
    const formErr = await expectStatus(
      () => service.completeTask(task.id, alice, { outcome: "approve", comment: "ok", data: { amount: "1" } }),
      422,
    );
    expect(formErr.details?.[0]?.path).toBe("/amount");
    expect(store.get(task.id)!.status).toBe("open");
  });

  test("non-assignees get 404, also when they know the ID", async () => {
    const task = service.createTask(input());
    await expectStatus(() => service.completeTask(task.id, carol, { outcome: "approve" }), 404);
  });

  test("a failing source handler does not undo the completion", async () => {
    service.registerSourceHandler("workflow", {
      onCompleted: () => {
        throw new Error("boom");
      },
    });
    const task = service.createTask(input());

    const result = await service.completeTask(task.id, alice, { outcome: "approve" });

    expect(result.status).toBe("completed");
  });
});

describe("manager actions and source-driven endings", () => {
  test("cancelTask requires manage rights, records the reason, and calls the source", async () => {
    const cancelled: [string, string | null][] = [];
    service.registerSourceHandler("workflow", { onCancelled: (t, r) => void cancelled.push([t.id, r]) });
    const task = service.createTask(input());

    await expectStatus(() => service.cancelTask(task.id, alice, "nope"), 403);
    const result = await service.cancelTask(task.id, admin, "duplicate");

    expect(result.status).toBe("cancelled");
    expect(cancelled).toEqual([[task.id, "duplicate"]]);
    expect(store.listEvents(task.id).at(-1)).toMatchObject({ kind: "cancelled", data: { reason: "duplicate" } });
    await expectStatus(() => service.cancelTask(task.id, admin), 409);
  });

  test("reassignTask replaces the assignees", async () => {
    const task = service.createTask(input({ assignees: { users: ["alice"] } }));

    service.reassignTask(task.id, admin, { users: ["carol"] });

    expect(service.getTask(task.id, carol).canRespond).toBe(true);
    await expectStatus(() => service.getTask(task.id, alice), 404);
    await expectStatus(() => service.reassignTask(task.id, alice, { users: ["alice"] }), 403);
  });

  test("cancelBySource cancels only open tasks of that source without calling back", async () => {
    const called: string[] = [];
    service.registerSourceHandler("workflow", { onCancelled: (t) => void called.push(t.id) });
    const open = service.createTask(input());
    const done = service.createTask(input());
    await service.completeTask(done.id, alice, { outcome: "approve" });
    const other = service.createTask(
      input({ source: { kind: "workflow", id: "run-2", ref: { runId: "run-2", stepSlug: "x", signalId: "s" } } }),
    );

    expect(service.cancelBySource("workflow", "run-1", "run failed")).toBe(1);
    expect(store.get(open.id)!.status).toBe("cancelled");
    expect(store.get(done.id)!.status).toBe("completed");
    expect(store.get(other.id)!.status).toBe("open");
    expect(called).toEqual([]);
  });

  test("expireTask ends an open task once", () => {
    const task = service.createTask(input());

    expect(service.expireTask(task.id)).toBe(true);
    expect(service.expireTask(task.id)).toBe(false);
    expect(store.get(task.id)!.status).toBe("expired");
  });
});

describe("countTasks", () => {
  test("counts open tasks assigned to the viewer and those due within 24 hours", async () => {
    service.createTask(input({ dueAt: clock + 60_000 }));
    service.createTask(input({ dueAt: clock + 3 * 24 * 60 * 60 * 1000 }));
    service.createTask(input({ assignees: { users: ["carol"] } }));
    const done = service.createTask(input());
    await service.completeTask(done.id, alice, { outcome: "approve" });

    expect(service.countTasks(alice)).toEqual({ open: 2, dueSoon: 1 });
    expect(service.countTasks(carol)).toEqual({ open: 1, dueSoon: 0 });
  });
});

describe("viewFor", () => {
  test("returns the view only for users who may see the task", () => {
    const task = service.createTask(input());

    expect(service.viewFor(task, alice)?.id).toBe(task.id);
    expect(service.viewFor(task, carol)).toBeNull();
  });
});
