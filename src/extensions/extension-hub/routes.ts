/**
 * HTTP routes of the Extension Hub (mounted under `/ext/extension-hub/`).
 *
 * Reads are open to every signed-in user. Writes install code that runs in
 * the server process, so they are admin-only (`manage Extension`) via the
 * central authorization table.
 *
 * @module
 */

import { formatValidationErrors } from "@ext/sdk";
import type { ExtensionContext } from "@ext/types";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "elysia";
import { HubError } from "./errors";
import type { HubService } from "./hub";

const OptionalNullableString = Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()]));

/** Body of `POST /sources`. */
const CreateSourceSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    url: Type.String({ minLength: 1, maxLength: 500 }),
    branch: OptionalNullableString,
    token: OptionalNullableString,
  },
  { additionalProperties: false },
);

/** Body of `PUT /sources/:id` (partial update). */
const UpdateSourceSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    branch: OptionalNullableString,
    token: OptionalNullableString,
  },
  { additionalProperties: false },
);

/** Body of `POST /install`. */
const InstallSchema = Type.Object(
  {
    sourceId: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 64 }),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

/** Route handler signature. */
type Handler = (reqCtx: Context) => Response | Promise<Response>;

/**
 * Validates a request body.
 *
 * @throws {HubError} 400 when invalid
 */
function check<T extends TSchema>(schema: T, body: unknown): Static<T> {
  if (!Value.Check(schema, body)) {
    throw new HubError(400, `Invalid request: ${formatValidationErrors(schema, body)}`);
  }
  return body as Static<T>;
}

/**
 * Registers all hub routes.
 *
 * @param ctx - Extension context
 * @param hub - The hub service
 * @param getUserId - Resolves the requesting user's id
 * @param hasToken - Reports whether a source has an HTTPS token stored
 */
export function registerRoutes(
  ctx: ExtensionContext,
  hub: HubService,
  getUserId: (request: Request) => string | undefined,
  hasToken: (sourceId: string) => Promise<boolean>,
): void {
  const wrap =
    (fn: Handler): Handler =>
    async (reqCtx) => {
      try {
        return await fn(reqCtx);
      } catch (err) {
        if (err instanceof HubError) {
          return Response.json({ error: err.message, details: err.details }, { status: err.status });
        }
        ctx.log.error(`[extension-hub] ${(err as Error).stack ?? err}`);
        return Response.json({ error: (err as Error).message || "Internal error" }, { status: 500 });
      }
    };
  const param = (reqCtx: Context, key: string) => (reqCtx.params as Record<string, string>)[key] ?? "";

  ctx.routes.register(
    "GET",
    "/sources",
    wrap(async () => {
      const sources = await Promise.all(hub.listSources().map(async (s) => ({ ...s, hasToken: await hasToken(s.id) })));
      return Response.json({ sources });
    }),
  );

  ctx.routes.register(
    "POST",
    "/sources",
    wrap(async (reqCtx) => {
      const body = check(CreateSourceSchema, reqCtx.body);
      return Response.json(await hub.createSource(body), { status: 201 });
    }),
  );

  ctx.routes.register(
    "PUT",
    "/sources/:id",
    wrap(async (reqCtx) => {
      const body = check(UpdateSourceSchema, reqCtx.body);
      return Response.json(await hub.updateSource(param(reqCtx, "id"), body));
    }),
  );

  ctx.routes.register(
    "DELETE",
    "/sources/:id",
    wrap(async (reqCtx) => {
      await hub.deleteSource(param(reqCtx, "id"));
      return new Response(null, { status: 204 });
    }),
  );

  ctx.routes.register(
    "POST",
    "/sources/:id/refresh",
    wrap(async (reqCtx) => Response.json(await hub.refreshSource(param(reqCtx, "id")))),
  );

  ctx.routes.register(
    "POST",
    "/refresh",
    wrap(async () => Response.json({ results: await hub.refreshAll() })),
  );

  ctx.routes.register(
    "GET",
    "/catalog",
    wrap(async () => Response.json(await hub.catalog())),
  );

  ctx.routes.register(
    "POST",
    "/install",
    wrap(async (reqCtx) => {
      const body = check(InstallSchema, reqCtx.body);
      if (body.version !== undefined && body.ref !== undefined) {
        throw new HubError(400, "Give either version or ref, not both");
      }
      const result = await hub.install({ ...body, userId: getUserId(reqCtx.request) ?? null });
      return Response.json(result, { status: 201 });
    }),
  );

  ctx.routes.register(
    "DELETE",
    "/installed/:name",
    wrap(async (reqCtx) => Response.json(await hub.uninstall(param(reqCtx, "name")))),
  );
}
