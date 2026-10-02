import { describe, expect, test } from "bun:test";
import type { Permission } from "@shared/auth";
import type { ResolvedPrincipal } from "@src/auth";
import { buildAbility } from "@src/auth";
import { setPrincipal } from "./auth";
import { requestUserId } from "./triggerOwnership";

describe("triggerOwnership", () => {
  /** Builds a request with a principal (built from the given identity) attached. */
  function reqWith(userId: string, isAdmin: boolean, permissions: string[]): Request {
    const principal: ResolvedPrincipal = {
      user: { id: userId, username: userId, roles: [] },
      isAdmin,
      permissions: permissions as Permission[],
      ability: buildAbility({ userId, isAdmin, permissions: permissions as Permission[] }),
    };
    const request = new Request("http://localhost/ext/webhooks/x");
    setPrincipal(request, principal);
    return request;
  }

  test("requestUserId returns the principal's user id", () => {
    const request = reqWith("u1", false, ["triggers:write"]);
    expect(requestUserId(request)).toBe("u1");
  });

  test("requestUserId is undefined for an unauthenticated request", () => {
    expect(requestUserId(new Request("http://localhost/x"))).toBeUndefined();
  });
});
