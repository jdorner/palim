import { describe, expect, test } from "bun:test";
import { BUILT_IN_ROLES, PERMISSIONS, type PermissionSet, ROLE_USER } from "@shared/auth";
import { buildAbility } from "@src/auth";
import { authorizeRequest } from "./authorize";

/** Admin ability (manage all). */
const adminAbility = buildAbility({ userId: "admin", isAdmin: true, permissions: [] });
/** A chat-only user's ability (chat + read-only elsewhere). */
const userAbility = buildAbility({
  userId: "u1",
  isAdmin: false,
  permissions: [PERMISSIONS.CHAT_WRITE],
});

/** The real built-in "user" role, so these tests track the seeded permissions. */
const builtInUserAbility = buildAbility({
  userId: "u1",
  isAdmin: false,
  permissions: BUILT_IN_ROLES[ROLE_USER]?.permissions as PermissionSet,
});

describe("authorizeRequest", () => {
  test("allows requests that match no rule", () => {
    expect(authorizeRequest("POST", "/api/chat", userAbility).allowed).toBe(true);
    expect(authorizeRequest("GET", "/api/sessions/abc/messages", userAbility).allowed).toBe(true);
  });

  test("admin is allowed everywhere in the table", () => {
    expect(authorizeRequest("POST", "/api/users", adminAbility).allowed).toBe(true);
    expect(authorizeRequest("PUT", "/api/secrets", adminAbility).allowed).toBe(true);
    expect(authorizeRequest("PUT", "/api/models/selected", adminAbility).allowed).toBe(true);
    expect(authorizeRequest("PATCH", "/api/roles/r1/permissions", adminAbility).allowed).toBe(true);
  });

  test("allows every read to any principal, except user administration", () => {
    expect(authorizeRequest("GET", "/api/secrets", userAbility).allowed).toBe(true);
    expect(authorizeRequest("GET", "/api/secrets/audit", userAbility).allowed).toBe(true);
    expect(authorizeRequest("GET", "/api/variables", userAbility).allowed).toBe(true);
    expect(authorizeRequest("GET", "/api/extensions/telegram/secrets", userAbility).allowed).toBe(true);
    expect(authorizeRequest("GET", "/ext/workflows/runs", userAbility).allowed).toBe(true);
    expect(authorizeRequest("GET", "/ext/some-plugin/anything", userAbility).allowed).toBe(true);
    expect(authorizeRequest("HEAD", "/api/variables", userAbility).allowed).toBe(true);
    expect(authorizeRequest("GET", "/api/roles", userAbility).allowed).toBe(false);
    expect(authorizeRequest("HEAD", "/api/users", userAbility).allowed).toBe(false);
  });

  test("denies user management to non-admins", () => {
    expect(authorizeRequest("GET", "/api/users", userAbility).allowed).toBe(false);
    expect(authorizeRequest("POST", "/api/users", userAbility).allowed).toBe(false);
    expect(authorizeRequest("PUT", "/api/roles/r1/permissions", userAbility).allowed).toBe(false);
  });

  test("denies secret and variable writes to a user without write permissions", () => {
    expect(authorizeRequest("PUT", "/api/secrets", userAbility).allowed).toBe(false);
    expect(authorizeRequest("POST", "/api/secrets", userAbility).allowed).toBe(false);
    expect(authorizeRequest("DELETE", "/api/variables/X", userAbility).allowed).toBe(false);
    expect(authorizeRequest("POST", "/api/variables", userAbility).allowed).toBe(false);
    expect(authorizeRequest("PUT", "/api/extensions/telegram/secrets", userAbility).allowed).toBe(false);
  });

  test("denies model changes to a read-only user", () => {
    expect(authorizeRequest("PUT", "/api/models/selected", userAbility).allowed).toBe(false);
  });

  test("job control requires jobs:write", () => {
    expect(authorizeRequest("POST", "/api/jobs/j1/cancel", userAbility).allowed).toBe(false);
    expect(authorizeRequest("POST", "/api/jobs/j1/retry", userAbility).allowed).toBe(false);
    expect(authorizeRequest("POST", "/api/queues/clean", userAbility).allowed).toBe(false);
    expect(authorizeRequest("POST", "/api/jobs/j1/cancel", builtInUserAbility).allowed).toBe(true);
    expect(authorizeRequest("POST", "/api/queues/clean", builtInUserAbility).allowed).toBe(true);
  });

  test("denies extension enable/disable to a read-only user", () => {
    expect(authorizeRequest("PUT", "/api/extensions/telegram", userAbility).allowed).toBe(false);
  });

  test("reports the required action/subject for diagnostics", () => {
    const decision = authorizeRequest("POST", "/api/users", userAbility);
    expect(decision.requiredAction).toBe("manage");
    expect(decision.requiredSubject).toBe("User");
  });

  describe("extension routes", () => {
    test("built-in user cannot register, edit, sync, or call MCP servers", () => {
      expect(authorizeRequest("POST", "/ext/mcp/servers", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("PUT", "/ext/mcp/servers/x", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("DELETE", "/ext/mcp/servers/x", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("POST", "/ext/mcp/servers/x/sync", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("POST", "/ext/mcp/servers/x/call", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("POST", "/ext/mcp/import", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("GET", "/ext/mcp/servers", builtInUserAbility).allowed).toBe(true);
    });

    test("built-in user can read but not edit or delete workflow definitions", () => {
      expect(authorizeRequest("GET", "/ext/workflows", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("GET", "/ext/workflows/wf", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("POST", "/ext/workflows/meta/validate", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("PUT", "/ext/workflows/wf", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("DELETE", "/ext/workflows/wf", builtInUserAbility).allowed).toBe(false);
    });

    test("workflows:manage grants definition edits", () => {
      const ability = buildAbility({ userId: "u2", isAdmin: false, permissions: [PERMISSIONS.WORKFLOWS_MANAGE] });
      expect(authorizeRequest("PUT", "/ext/workflows/wf", ability).allowed).toBe(true);
      expect(authorizeRequest("DELETE", "/ext/workflows/wf", ability).allowed).toBe(true);
    });

    test("built-in user can start and modify any run", () => {
      expect(authorizeRequest("POST", "/ext/workflows/run/wf", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("GET", "/ext/workflows/runs", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("GET", "/ext/workflows/runs/r1/logs", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("POST", "/ext/workflows/runs/r1/signal/go", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("DELETE", "/ext/workflows/runs/r1", builtInUserAbility).allowed).toBe(true);
    });

    test("a user without workflows:write cannot start or delete runs", () => {
      expect(authorizeRequest("POST", "/ext/workflows/run/wf", userAbility).allowed).toBe(false);
      expect(authorizeRequest("DELETE", "/ext/workflows/runs/r1", userAbility).allowed).toBe(false);
    });

    test("built-in user can manage any trigger", () => {
      expect(authorizeRequest("POST", "/ext/scheduler/schedules", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("POST", "/ext/scheduler/schedules/s1/trigger", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("PUT", "/ext/webhooks/hook", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("DELETE", "/ext/filewatcher/w", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("POST", "/ext/webhooks", userAbility).allowed).toBe(false);
    });

    test("data table writes need datatables:write; reads are open", () => {
      expect(authorizeRequest("GET", "/ext/datatables/tables/t/rows", userAbility).allowed).toBe(true);
      expect(authorizeRequest("GET", "/ext/datatables/tables/t/export", userAbility).allowed).toBe(true);
      expect(authorizeRequest("POST", "/ext/datatables/tables", userAbility).allowed).toBe(false);
      expect(authorizeRequest("POST", "/ext/datatables/tables/t/rows", userAbility).allowed).toBe(false);
      expect(authorizeRequest("POST", "/ext/datatables/import", userAbility).allowed).toBe(false);
      expect(authorizeRequest("PUT", "/ext/datatables/tables/t", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("DELETE", "/ext/datatables/tables/t", builtInUserAbility).allowed).toBe(true);
      expect(authorizeRequest("POST", "/ext/datatables/tables/t/truncate", builtInUserAbility).allowed).toBe(true);
      const decision = authorizeRequest("POST", "/ext/datatables/tables", userAbility);
      expect(decision.requiredSubject).toBe("DataTable");
    });

    test("unlisted extension writes are admin-only", () => {
      expect(authorizeRequest("POST", "/ext/some-plugin/anything", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("POST", "/ext/ext-installer/approve/x", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("POST", "/ext/wiki/reindex", builtInUserAbility).allowed).toBe(false);
      expect(authorizeRequest("POST", "/ext/some-plugin/anything", adminAbility).allowed).toBe(true);
      const decision = authorizeRequest("POST", "/ext/some-plugin/anything", builtInUserAbility);
      expect(decision.requiredAction).toBe("manage");
      expect(decision.requiredSubject).toBe("Extension");
    });
  });
});
