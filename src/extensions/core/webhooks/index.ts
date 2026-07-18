/**
 * Webhooks extension - exposes authenticated HTTP endpoints that external
 * services (GitHub, Stripe, CRMs, etc.) can POST to, emitting domain events
 * on the shared event bus for downstream consumers (e.g. workflows).
 *
 * Exposes:
 * - Receiver route: `POST /ext/webhooks/receive/:slug`
 * - REST CRUD routes under `/ext/webhooks`
 * - Agent tool: `manage_webhooks` for create/list/delete/get
 *
 * Webhook registrations are persisted in the shared SQLite database via Drizzle ORM.
 *
 * Authentication supports HMAC-SHA256 signature verification (GitHub-style),
 * simple bearer token auth, or no authentication.
 *
 * State is encapsulated in a factory function so each call to
 * {@link createExtension} produces an isolated instance.
 */

import { formatValidationErrors } from "@ext/sdk";
import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { verifyAuth } from "./auth";
import { CreateWebhookPayload, UpdateWebhookPayload } from "./schemas";
import { deleteWebhook, findWebhook, initStore, insertWebhook, loadAll, updateWebhookRecord } from "./store";
import type { WebhookAuthType, WebhookRegistration } from "./types";

/** Whether the application is running in development mode. */
const IS_DEV = !process.env.NODE_ENV || process.env.NODE_ENV === "development";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const manifest = {
  name: "webhooks",
  version: "1.0.0",
  description: "Authenticated HTTP endpoints for receiving external service events",
  dependencies: [],
  core: true,
  settingsSchema: Type.Object({
    maxPayloadSize: Type.Number({
      title: "Max Payload Size",
      description: "Maximum allowed webhook payload size in bytes",
      default: 1048576,
      minimum: 1024,
    }),
  }),
  ui: {
    navigation: [
      {
        label: "Webhooks",
        route: "/webhooks",
        icon: "LinkIcon",
        order: 70,
        badgeKey: "webhookCount",
        iconColor: "text-emerald-500 dark:text-emerald-300",
      },
    ],
  },
} satisfies ExtensionManifest;

/**
 * Creates a fresh Webhooks extension instance with its own encapsulated state.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let logger: Logger;
  let maxPayloadSize = 1024 * 1024; // 1 MB default

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;
      initStore(ctx.getDatabase());

      // Read optional config
      const maxSizeCfg = ctx.getConfig("MAX_PAYLOAD_SIZE");
      if (maxSizeCfg !== undefined) {
        const parsed = typeof maxSizeCfg === "number" ? maxSizeCfg : Number.parseInt(String(maxSizeCfg), 10);
        if (!Number.isNaN(parsed) && parsed > 0) maxPayloadSize = parsed;
      }

      // Load registrations
      const all = loadAll();
      logger.info(`Loaded ${all.length} webhook registration(s)`);

      // ---------------------------------------------------------------
      // Receiver route: POST /ext/webhooks/receive/:slug
      // ---------------------------------------------------------------
      ctx.registerRoute("POST", "/receive/:slug", async (reqCtx) => {
        const slug = (reqCtx.params as Record<string, string>).slug;
        if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

        const registration = findWebhook(slug);
        if (!registration) return Response.json({ error: "Webhook not found" }, { status: 404 });
        if (!registration.enabled) return Response.json({ error: "Webhook is disabled" }, { status: 403 });

        // Deny unauthenticated webhooks in non-development environments
        if (registration.authType === "none" && !IS_DEV) {
          logger.warn(`Blocked unauthenticated webhook "${slug}" - authType "none" is only allowed in development`);
          return Response.json(
            { error: "Unauthenticated webhooks are only available in development mode" },
            { status: 403 },
          );
        }

        // Read raw body for HMAC verification
        const rawBody = typeof reqCtx.body === "string" ? reqCtx.body : JSON.stringify(reqCtx.body ?? "");

        if (rawBody.length > maxPayloadSize) {
          return Response.json({ error: "Payload too large" }, { status: 413 });
        }

        // Verify authentication
        const headerValue = reqCtx.headers[registration.headerName.toLowerCase()] ?? null;
        const authentic = await verifyAuth(registration, headerValue, rawBody);
        if (!authentic) {
          logger.warn(`Auth failed for webhook "${slug}"`);
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Parse payload
        let payload: unknown;
        try {
          payload = typeof reqCtx.body === "string" ? JSON.parse(reqCtx.body) : reqCtx.body;
        } catch {
          payload = rawBody;
        }

        // Emit domain event for downstream consumers (e.g. workflow engine)
        ctx.emitEvent({
          type: "webhook:received",
          context: { source: "webhooks", id: slug, slug, payload },
        });

        logger.info(`Webhook "${slug}" received -> event emitted`);
        return Response.json({ ok: true }, { status: 202 });
      });

      // ---------------------------------------------------------------
      // CRUD routes for webhook registrations
      // ---------------------------------------------------------------

      // GET /ext/webhooks/
      ctx.registerRoute("GET", "/", async () => {
        const all = loadAll();
        // Strip secrets from the response
        const safe = all.map(({ secret: _s, ...rest }) => rest);
        return Response.json(safe);
      });

      // POST /ext/webhooks/
      ctx.registerRoute("POST", "/", async (reqCtx) => {
        const body = reqCtx.body as Record<string, unknown>;
        if (!Value.Check(CreateWebhookPayload, body)) {
          return Response.json(
            { error: `Validation failed: ${formatValidationErrors(CreateWebhookPayload, body)}` },
            { status: 400 },
          );
        }

        const data = body as {
          slug: string;
          name: string;
          authType: WebhookAuthType;
          secret?: string;
          headerName?: string;
          enabled?: boolean;
        };

        // Deny authType "none" in non-development environments
        if (data.authType === "none" && !IS_DEV) {
          return Response.json(
            { error: 'authType "none" is only allowed in development mode (NODE_ENV=development)' },
            { status: 400 },
          );
        }

        if (findWebhook(data.slug)) {
          return Response.json({ error: `Webhook "${data.slug}" already exists` }, { status: 409 });
        }

        if (data.authType !== "none" && (!data.secret || data.secret.length < 8)) {
          return Response.json(
            { error: "Secret is required (min 8 chars) for hmac-sha256 and bearer auth" },
            { status: 400 },
          );
        }

        const defaultHeader =
          data.authType === "none" ? "" : data.authType === "bearer" ? "Authorization" : "X-Hub-Signature-256";

        const registration: WebhookRegistration = {
          slug: data.slug,
          name: data.name,
          authType: data.authType,
          secret: data.secret || "",
          headerName: data.headerName || defaultHeader,
          enabled: data.enabled ?? true,
          createdAt: Date.now(),
        };

        insertWebhook(registration);
        ctx.broadcast({ type: "webhooks_reload" });

        logger.info(`Created webhook "${data.slug}"`);
        const { secret: _s, ...safe } = registration;
        return Response.json(safe, { status: 201 });
      });

      // GET /ext/webhooks/:slug - get webhook details (secret stripped)
      ctx.registerRoute("GET", "/:slug", async (reqCtx) => {
        const slug = (reqCtx.params as Record<string, string>).slug;
        if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

        const wh = findWebhook(slug);
        if (!wh) return Response.json({ error: "Not found" }, { status: 404 });

        const { secret: _s, ...safe } = wh;
        return Response.json(safe);
      });

      // DELETE /ext/webhooks/:slug
      ctx.registerRoute("DELETE", "/:slug", async (reqCtx) => {
        const slug = (reqCtx.params as Record<string, string>).slug;
        if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

        if (!deleteWebhook(slug)) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }

        ctx.broadcast({ type: "webhooks_reload" });
        logger.info(`Deleted webhook "${slug}"`);
        return Response.json({ ok: true });
      });

      // PUT /ext/webhooks/:slug - update an existing webhook
      ctx.registerRoute("PUT", "/:slug", async (reqCtx) => {
        const slug = (reqCtx.params as Record<string, string>).slug;
        if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

        const body = reqCtx.body as Record<string, unknown>;
        if (!Value.Check(UpdateWebhookPayload, body)) {
          return Response.json(
            { error: `Validation failed: ${formatValidationErrors(UpdateWebhookPayload, body)}` },
            { status: 400 },
          );
        }

        const existing = findWebhook(slug);
        if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

        const updates = body as {
          name?: string;
          authType?: WebhookAuthType;
          secret?: string;
          headerName?: string;
          enabled?: boolean;
        };

        // Deny switching to authType "none" in non-development environments
        if (updates.authType === "none" && !IS_DEV) {
          return Response.json(
            { error: 'authType "none" is only allowed in development mode (NODE_ENV=development)' },
            { status: 400 },
          );
        }

        // Determine the effective authType after this update
        const effectiveAuthType = updates.authType ?? existing.authType;

        // If switching to an authenticated type, ensure a valid secret exists
        if (effectiveAuthType !== "none") {
          const effectiveSecret = updates.secret ?? existing.secret;
          if (!effectiveSecret || effectiveSecret.length < 8) {
            return Response.json(
              { error: "Secret is required (min 8 chars) for hmac-sha256 and bearer auth" },
              { status: 400 },
            );
          }
        }

        // Build the update payload
        const mergeUpdates: Partial<Omit<WebhookRegistration, "slug" | "createdAt">> = {};

        // If switching to "none", clear secret and headerName
        if (updates.authType === "none") {
          mergeUpdates.authType = "none";
          mergeUpdates.secret = "";
          mergeUpdates.headerName = "";
        } else if (updates.authType !== undefined) {
          mergeUpdates.authType = updates.authType;
        }

        if (updates.name !== undefined) mergeUpdates.name = updates.name;
        if (updates.secret !== undefined && effectiveAuthType !== "none") mergeUpdates.secret = updates.secret;
        if (updates.headerName !== undefined) mergeUpdates.headerName = updates.headerName;
        if (updates.enabled !== undefined) mergeUpdates.enabled = updates.enabled;

        const updated = updateWebhookRecord(slug, mergeUpdates);
        if (!updated) return Response.json({ error: "Not found" }, { status: 404 });

        logger.info(`Updated webhook "${slug}"`);
        const { secret: _s, ...safe } = updated;
        return Response.json(safe);
      });
    },

    async shutdown() {},
  };
}

export default createExtension();
