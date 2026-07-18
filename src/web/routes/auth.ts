/**
 * Authentication validation route.
 *
 * Handles `POST /api/auth/validate` for clients to check whether a
 * bearer token is valid (or whether auth is disabled entirely).
 */

import { Type } from "@sinclair/typebox";
import { Elysia } from "elysia";
import { authEnabled, validateToken } from "../auth";

/**
 * Creates the auth validation route group.
 *
 * @returns Elysia plugin with auth routes
 */
export function authRoutes() {
  return new Elysia().post(
    "/api/auth/validate",
    ({ body, status }) => {
      if (!authEnabled) {
        return status(200, { valid: true, authDisabled: true });
      }
      return status(200, { valid: validateToken(body.token ?? "") });
    },
    {
      body: Type.Object({
        token: Type.Optional(Type.String({ description: "Bearer token to validate" })),
      }),
    },
  );
}
