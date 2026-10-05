/**
 * Authentication routes: login, logout, and current-user introspection.
 *
 * - `POST /api/auth/login` - exchange username/password for an opaque bearer token.
 * - `POST /api/auth/logout` - revoke the presented bearer token.
 * - `GET /api/auth/me` - return the authenticated user and serialized ability.
 *
 * @module
 */

import { Type } from "@sinclair/typebox";
import type { AuthResolver } from "@src/auth";
import { serializeAbility } from "@src/auth";
import { Elysia } from "elysia";
import { clientAddress, extractBearerToken } from "../auth";
import type { LoginThrottle } from "../loginThrottle";

/** Minimal login-capable surface of the auth service. */
export interface LoginService extends AuthResolver {
  /**
   * Authenticate a username/password pair and issue a token.
   *
   * @param username - The login username.
   * @param password - The plaintext password.
   * @returns A login result (token + principal) or null on failure.
   */
  login(
    username: string,
    password: string,
  ): Promise<{
    token: string;
    expiresAt: number;
    principal: import("@src/auth").ResolvedPrincipal;
  } | null>;
  /**
   * Revoke a bearer token.
   *
   * @param token - The token to revoke.
   * @returns True when a session was removed.
   */
  logout(token: string): boolean;
}

/**
 * Creates the auth route group.
 *
 * @param getAuthService - Getter for the auth service (may be undefined during startup).
 * @param onSessionRevoked - Called after a logout revokes a token (e.g. to close its open WebSockets).
 * @param throttle - Optional brute-force throttle; locked-out attempts get 429 without checking the password.
 * @returns Elysia plugin with auth routes.
 */
export function authRoutes(
  getAuthService: () => LoginService | undefined,
  onSessionRevoked?: () => void,
  throttle?: LoginThrottle,
) {
  return new Elysia()
    .post(
      "/api/auth/login",
      async ({ body, status, request, server, set }) => {
        const auth = getAuthService();
        if (!auth) return status(503, { error: "Auth service unavailable" });

        const ip = clientAddress(request, server);
        const waitMs = throttle?.retryAfterMs(ip, body.username) ?? 0;
        if (waitMs > 0) {
          const retryAfter = Math.ceil(waitMs / 1000);
          set.headers["retry-after"] = String(retryAfter);
          return status(429, { error: "Too many failed login attempts", retryAfter });
        }

        const result = await auth.login(body.username, body.password);
        if (!result) {
          throttle?.recordFailure(ip, body.username);
          return status(401, { error: "Invalid username or password" });
        }
        throttle?.recordSuccess(ip, body.username);
        return status(200, {
          token: result.token,
          expiresAt: result.expiresAt,
          user: result.principal.user,
          ability: serializeAbility(result.principal),
        });
      },
      {
        body: Type.Object({
          username: Type.String({ minLength: 1, description: "Login username" }),
          password: Type.String({ minLength: 1, description: "Plaintext password" }),
        }),
      },
    )
    .post("/api/auth/logout", ({ request, status }) => {
      const auth = getAuthService();
      if (!auth) return status(503, { error: "Auth service unavailable" });
      const token = extractBearerToken(request.headers.get("authorization"));
      const revoked = auth.logout(token);
      if (revoked) onSessionRevoked?.();
      return status(200, { success: revoked });
    })
    .get("/api/auth/me", ({ request, status }) => {
      const auth = getAuthService();
      if (!auth) return status(503, { error: "Auth service unavailable" });
      const token = extractBearerToken(request.headers.get("authorization"));
      const principal = auth.resolveToken(token);
      if (!principal) {
        return status(401, { error: "Unauthorized" });
      }
      return status(200, {
        user: principal.user,
        ability: serializeAbility(principal),
      });
    });
}
