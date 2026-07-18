/**
 * Registers the `webhook` shell command for managing and testing
 * webhook endpoints from the agent sandbox.
 *
 * Subcommands: list, get, create, delete, test
 */

import { createHmac } from "node:crypto";
import {
  createCommand,
  formatFetchError,
  formatHttpError,
  type ParsedArgs,
  registerProgram,
  type SkillScriptContext,
} from "@ext/sdk";
import type { CommandContext, ExecResult } from "just-bash";

/**
 * A webhook record returned from admin API endpoints.
 * Secrets are stripped from list and get responses for safety.
 * The `secret` field may be present only when an endpoint intentionally
 * includes it (e.g. for testing HMAC signatures).
 */
export type WebhookResponse = {
  slug: string;
  name: string;
  authType: string;
  headerName: string;
  secret?: string;
  enabled: boolean;
  createdAt?: number;
};

/** An error response body from the webhook admin API. */
export type ApiError = { error: string };

/**
 * Builds the `webhook` command handler function.
 *
 * Exported for unit testing - allows injecting a context without
 * booting the full extension system.
 *
 * @param scriptCtx - Skill script context providing the extension base URL and authenticated fetch
 * @returns A command handler suitable for `registerProgram()`
 */
export function buildWebhookCommand(scriptCtx: SkillScriptContext) {
  return createCommand({
    name: "webhook",
    description: "Manage webhook endpoints for external service integrations.",
    subcommands: [
      {
        name: "list",
        description: "List all registered webhooks",
        handler: buildListHandler(scriptCtx),
      },
      {
        name: "get",
        description: "Get details for a specific webhook",
        args: [{ name: "slug", description: "Webhook slug" }],
        handler: buildGetHandler(scriptCtx),
      },
      {
        name: "create",
        description: "Create a new webhook endpoint",
        args: [
          { name: "slug", description: "URL-safe slug (lowercase, alphanumeric, hyphens)" },
          { name: "name", description: "Human-readable label" },
          { name: "authType", description: "Auth type: hmac-sha256, bearer, or none" },
          {
            name: "secret",
            required: false,
            description: 'HMAC secret or bearer token (min 8 chars). Use "" for none',
          },
        ],
        handler: buildCreateHandler(scriptCtx),
      },
      {
        name: "delete",
        description: "Delete a webhook by slug",
        args: [{ name: "slug", description: "Webhook slug to delete" }],
        handler: buildDeleteHandler(scriptCtx),
      },
      {
        name: "update",
        description: "Update a webhook field",
        args: [
          { name: "slug", description: "Webhook slug to update" },
          {
            name: "field",
            description: "Field to update: name, authType, secret, enabled",
          },
          { name: "value", description: "New value for the field" },
        ],
        handler: buildUpdateHandler(scriptCtx),
      },
      {
        name: "test",
        description: "Send a test request to a webhook endpoint",
        args: [
          { name: "slug", description: "Webhook slug to test" },
          { name: "payload", description: "JSON payload to send" },
        ],
        handler: buildTestHandler(scriptCtx),
      },
    ],
  });
}

/**
 * Registers the `webhook` shell command with the sandbox.
 *
 * @param skillName - The skill name this program belongs to
 * @param ctx - Skill script context providing the extension base URL and authenticated fetch
 */
export async function registerSkill(skillName: string, ctx: SkillScriptContext) {
  const command = buildWebhookCommand(ctx);
  registerProgram("webhook", command, skillName);
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

function buildListHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext): Promise<ExecResult> => {
    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}`);
      if (!resp.ok) return formatHttpError(resp);

      const body = (await resp.json()) as WebhookResponse[];
      if (!Array.isArray(body) || body.length === 0) {
        return { exitCode: 0, stdout: "No webhooks registered.", stderr: "" };
      }

      const lines = ["Registered Webhooks:", ""];
      for (const wh of body) {
        const status = wh.enabled ? "enabled" : "disabled";
        const endpoint = `/ext/webhooks/receive/${wh.slug}`;
        lines.push(`${wh.slug}: "${wh.name}" [${wh.authType}, ${status}]`);
        lines.push(`  Endpoint: POST ${endpoint}`);
        lines.push("");
      }

      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

function buildGetHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}`);
      if (!resp.ok) return formatHttpError(resp);

      const body = (await resp.json()) as WebhookResponse[];
      if (!Array.isArray(body)) {
        return { exitCode: 1, stdout: "", stderr: `Unexpected response format` };
      }

      const wh = body.find((w) => w.slug === slug);

      if (!wh) {
        return { exitCode: 1, stdout: "", stderr: `Webhook "${slug}" not found.` };
      }

      const lines = [
        `Webhook: ${wh.name}`,
        `  Slug: ${wh.slug}`,
        `  Auth: ${wh.authType}`,
        `  Header: ${wh.headerName}`,
        `  Enabled: ${wh.enabled}`,
        `  Endpoint: POST /ext/webhooks/receive/${wh.slug}`,
        `  Created: ${wh.createdAt != null ? new Date(wh.createdAt).toLocaleString() : "N/A"}`,
      ];

      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

function buildCreateHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");
    const name = args.get("name");
    const authType = args.get("authType");
    const secret = args.get("secret");

    if (authType !== "hmac-sha256" && authType !== "bearer" && authType !== "none") {
      return { exitCode: 1, stdout: "", stderr: 'Error: authType must be "hmac-sha256", "bearer", or "none"' };
    }

    if (authType !== "none" && (!secret || secret.length < 8)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Error: secret is required (min 8 chars) for hmac-sha256 and bearer auth",
      };
    }

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name, authType, secret: authType === "none" ? "" : secret }),
      });

      const body = (await resp.json()) as WebhookResponse | ApiError;

      if (resp.status === 201) {
        return {
          exitCode: 0,
          stdout: `Webhook created: "${name}"\n  Endpoint: POST /ext/webhooks/receive/${slug}\n  Auth: ${authType}`,
          stderr: "",
        };
      }

      const errMsg = (body as { error?: string })?.error ?? `HTTP ${resp.status}`;
      return { exitCode: 1, stdout: "", stderr: `Error: ${errMsg}` };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

function buildDeleteHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/${slug}`, { method: "DELETE" });
      const body = (await resp.json()) as { ok?: boolean; error?: string };

      if (resp.ok && body.ok) {
        return { exitCode: 0, stdout: `Webhook "${slug}" deleted.`, stderr: "" };
      }

      const errMsg = body.error ?? `HTTP ${resp.status}`;
      return { exitCode: 1, stdout: "", stderr: `Error: ${errMsg}` };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

const UPDATABLE_FIELDS = new Set(["name", "authType", "secret", "enabled"]);

function buildUpdateHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");
    const field = args.get("field");
    const value = args.get("value");

    if (!UPDATABLE_FIELDS.has(field)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: invalid field "${field}". Valid fields: ${[...UPDATABLE_FIELDS].join(", ")}`,
      };
    }

    // Coerce "enabled" to boolean
    let parsed: unknown = value;
    if (field === "enabled") {
      if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else {
        return { exitCode: 1, stdout: "", stderr: 'Error: enabled must be "true" or "false"' };
      }
    }

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: parsed }),
      });

      const body = (await resp.json()) as WebhookResponse | { error?: string };

      if (resp.ok) {
        return { exitCode: 0, stdout: `Webhook "${slug}" updated: ${field} = ${value}`, stderr: "" };
      }

      const errMsg = (body as { error?: string })?.error ?? `HTTP ${resp.status}`;
      return { exitCode: 1, stdout: "", stderr: `Error: ${errMsg}` };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

function buildTestHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");
    const payloadStr = args.get("payload");

    // Validate JSON
    try {
      JSON.parse(payloadStr);
    } catch {
      return { exitCode: 1, stdout: "", stderr: "Error: payload must be valid JSON" };
    }

    try {
      // Fetch webhook details (including secret) via API
      const detailResp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/${slug}`);
      if (!detailResp.ok) {
        if (detailResp.status === 404) {
          return { exitCode: 1, stdout: "", stderr: `Error: Webhook "${slug}" not found` };
        }
        return formatHttpError(detailResp);
      }

      const wh = (await detailResp.json()) as WebhookResponse;

      if (!wh.enabled) {
        return { exitCode: 1, stdout: "", stderr: `Error: Webhook "${slug}" is disabled` };
      }

      const secret = wh.secret ?? "";
      if (!secret && wh.authType !== "none") {
        return { exitCode: 1, stdout: "", stderr: `Error: Webhook "${slug}" has no secret for testing` };
      }

      // Build auth headers
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      if (wh.authType === "hmac-sha256") {
        const hmac = createHmac("sha256", secret).update(payloadStr).digest("hex");
        headers[wh.headerName] = `sha256=${hmac}`;
      } else if (wh.authType === "bearer") {
        headers[wh.headerName] = secret;
      }

      // Send the test request
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/receive/${slug}`, {
        method: "POST",
        headers,
        body: payloadStr,
      });

      const body = (await resp.json()) as ApiError;

      if (resp.ok) {
        return { exitCode: 0, stdout: `Test successful (${resp.status})`, stderr: "" };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: `Test failed (${resp.status}): ${body.error ?? JSON.stringify(body)}`,
      };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}
