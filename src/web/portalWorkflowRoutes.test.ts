/**
 * Tests for the portal workflow launcher API: listing, starting with an
 * upload, validation, visibility by role, and authorization.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILT_IN_ROLES, PERMISSIONS, ROLE_ADMIN, ROLE_PORTAL_USER } from "@shared/auth";
import { matchesAccept, type PortalWorkflow } from "@shared/portal";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import {
  createPortalLauncherRegistry,
  describeRunAsUser,
  type PortalLauncherDef,
  type PortalLauncherRegistry,
} from "@src/portal";
import { Elysia } from "elysia";
import { portalWorkflowRoutes, sanitizeUploadName } from "./routes/portal/workflows";
import { authCheck } from "./server";

/** A 1x1 PNG. */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

describe("portal workflow API", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;
  let registry: PortalLauncherRegistry;
  let workDir: string;
  let launchers: PortalLauncherDef[];
  let started: { name: string; payload: unknown; initiatorUserId: string }[];
  let app: ReturnType<typeof buildApp>;

  function buildApp() {
    return new Elysia()
      .onBeforeHandle((c) => authCheck(c as never, auth))
      .use(portalWorkflowRoutes(() => registry, workDir));
  }

  async function seed(username: string, kind: "operator" | "portal", roleNames: string[]): Promise<string> {
    const user = store.createUser({ username, passwordHash: await auth.hashPassword("pw"), kind });
    store.setUserRoles(
      user.id,
      roleNames.map((n) => store.getRoleByName(n)!.id),
    );
    return user.id;
  }

  async function login(username: string): Promise<string> {
    return (await auth.login(username, "pw"))?.token ?? "";
  }

  function launcher(overrides: Partial<PortalLauncherDef> = {}): PortalLauncherDef {
    return {
      name: "receipts",
      title: "Receipts",
      description: null,
      accept: "image/*",
      fileRequired: true,
      maxSizeMb: 1,
      fields: null,
      roles: [],
      runAsUserId: store.getUserByUsername("owner")!.id,
      ...overrides,
    };
  }

  function startReq(token: string, name: string, parts: { file?: Blob | File; data?: string }): Request {
    const form = new FormData();
    if (parts.file) form.append("file", parts.file);
    if (parts.data !== undefined) form.append("data", parts.data);
    return new Request(`http://localhost/api/portal/workflows/${name}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  }

  const png = () => new File([PNG], "../../evil name?.png", { type: "image/png" });

  beforeEach(async () => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    for (const def of Object.values(BUILT_IN_ROLES)) {
      const role = store.createRole(def.name, def.description, true);
      if (def.permissions) store.setRolePermissions(role.id, def.permissions);
    }
    const starters = store.createRole("starters", undefined, false);
    store.setRolePermissions(starters.id, [PERMISSIONS.PORTAL_START]);
    const accounting = store.createRole("accounting", undefined, false);
    store.setRolePermissions(accounting.id, [PERMISSIONS.PORTAL_START]);
    await seed("owner", "operator", [ROLE_ADMIN]);
    await seed("sam", "portal", ["starters"]);
    await seed("acc", "portal", ["accounting"]);
    await seed("pat", "portal", [ROLE_PORTAL_USER]);

    workDir = await mkdtemp(path.join(tmpdir(), "palim-portal-"));
    launchers = [launcher()];
    started = [];
    registry = createPortalLauncherRegistry({ describeRunAs: (id) => describeRunAsUser(store, id) });
    registry.register({
      list: () => launchers,
      start: async (name, payload, initiatorUserId) => {
        started.push({ name, payload, initiatorUserId });
        return { runId: "run-1" };
      },
    });
    app = buildApp();
  });

  afterEach(async () => {
    ctx.sqlite.close();
    await rm(workDir, { recursive: true, force: true });
  });

  test("lists visible launchers without roles or run-as", async () => {
    launchers = [launcher(), launcher({ name: "invoices", title: "Invoices", roles: ["accounting"] })];
    const body = (await (
      await app.handle(
        new Request("http://localhost/api/portal/workflows", {
          headers: { Authorization: `Bearer ${await login("sam")}` },
        }),
      )
    ).json()) as PortalWorkflow[];
    expect(body.map((w) => w.name)).toEqual(["receipts"]);
    expect(body[0]).not.toHaveProperty("roles");
    expect(body[0]).not.toHaveProperty("runAsUserId");

    const acc = (await (
      await app.handle(
        new Request("http://localhost/api/portal/workflows", {
          headers: { Authorization: `Bearer ${await login("acc")}` },
        }),
      )
    ).json()) as PortalWorkflow[];
    expect(acc.map((w) => w.name)).toEqual(["invoices", "receipts"]);
  });

  test("an account without portal:start gets 403", async () => {
    const token = await login("pat");
    const res = await app.handle(
      new Request("http://localhost/api/portal/workflows", { headers: { Authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(403);
    expect((await app.handle(startReq(token, "receipts", { file: png() }))).status).toBe(403);
  });

  test("starts a run as the run-as account with the saved upload", async () => {
    const res = await app.handle(startReq(await login("sam"), "receipts", { file: png() }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "run-1" });

    expect(started).toHaveLength(1);
    const { payload, initiatorUserId } = started[0]!;
    expect(initiatorUserId).toBe(store.getUserByUsername("owner")!.id);
    const p = payload as {
      file: { path: string; name: string; mimeType: string; size: number };
      data: unknown;
      submittedBy: { username: string };
    };
    expect(p.file.name).toBe("evil name_.png");
    expect(p.file.mimeType).toBe("image/png");
    expect(p.file.size).toBe(PNG.length);
    expect(p.file.path).toMatch(/^uploads\/portal\/[0-9a-f-]{36}\/evil name_\.png$/);
    expect(p.data).toEqual({});
    expect(p.submittedBy.username).toBe("sam");
    expect(await Bun.file(path.join(workDir, p.file.path)).bytes()).toEqual(PNG);
  });

  test("a hidden launcher answers 404", async () => {
    launchers = [launcher({ roles: ["accounting"] })];
    expect((await app.handle(startReq(await login("sam"), "receipts", { file: png() }))).status).toBe(404);
  });

  test("rejects a missing file, an oversized file, and a wrong type", async () => {
    const token = await login("sam");
    expect((await app.handle(startReq(token, "receipts", {}))).status).toBe(400);

    launchers = [launcher({ maxSizeMb: 0.00001 })];
    expect((await app.handle(startReq(token, "receipts", { file: png() }))).status).toBe(413);

    launchers = [launcher()];
    const fake = new File(["hello"], "notes.txt", { type: "text/plain" });
    expect((await app.handle(startReq(token, "receipts", { file: fake }))).status).toBe(415);
    expect(started).toHaveLength(0);
  });

  test("validates form data against the fields schema", async () => {
    launchers = [
      launcher({
        fileRequired: false,
        fields: {
          type: "object",
          properties: { amount: { type: "number" }, note: { type: "string" } },
          required: ["amount"],
        },
      }),
    ];
    const token = await login("sam");
    expect((await app.handle(startReq(token, "receipts", { data: "{" }))).status).toBe(400);
    expect((await app.handle(startReq(token, "receipts", { data: "[]" }))).status).toBe(400);
    expect((await app.handle(startReq(token, "receipts", { data: '{"amount":"x"}' }))).status).toBe(422);

    const ok = await app.handle(startReq(token, "receipts", { data: '{"amount":12.5}' }));
    expect(ok.status).toBe(202);
    expect((started[0]!.payload as { file: unknown; data: unknown }).file).toBeNull();
    // Declared optional fields left empty arrive as null, so templates resolve them.
    expect((started[0]!.payload as { data: unknown }).data).toEqual({ amount: 12.5, note: null });
  });

  test("refuses to start without a usable run-as account and removes the upload", async () => {
    launchers = [launcher({ runAsUserId: null })];
    const token = await login("sam");
    expect((await app.handle(startReq(token, "receipts", { file: png() }))).status).toBe(409);

    // Portal accounts can never be run-as accounts.
    launchers = [launcher({ runAsUserId: store.getUserByUsername("acc")!.id })];
    expect((await app.handle(startReq(token, "receipts", { file: png() }))).status).toBe(409);

    expect(started).toHaveLength(0);
    expect(await readdir(path.join(workDir, "uploads/portal"))).toEqual([]);
  });
});

describe("sanitizeUploadName", () => {
  test("keeps a plain name and strips directories and odd characters", () => {
    expect(sanitizeUploadName("Beleg 2026-10.jpg")).toBe("Beleg 2026-10.jpg");
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("C:\\Users\\me\\photo.png")).toBe("photo.png");
    expect(sanitizeUploadName("..")).toBe("upload");
    expect(sanitizeUploadName(".hidden")).toBe("hidden");
    expect(sanitizeUploadName("a/b:c*d.png")).toBe("b_c_d.png");
  });
});

describe("matchesAccept", () => {
  test("matches MIME types, wildcards, and extensions", () => {
    expect(matchesAccept(null, "application/pdf", "a.pdf")).toBe(true);
    expect(matchesAccept("", "application/pdf", "a.pdf")).toBe(true);
    expect(matchesAccept("image/*", "image/jpeg", "a.jpg")).toBe(true);
    expect(matchesAccept("image/*", "application/pdf", "a.pdf")).toBe(false);
    expect(matchesAccept("image/*, application/pdf", "application/pdf", "a.pdf")).toBe(true);
    expect(matchesAccept(".CSV", "text/plain", "data.csv")).toBe(true);
  });
});
