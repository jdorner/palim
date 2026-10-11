/**
 * Portal workflow launcher routes.
 *
 * Handles:
 * - `GET  /api/portal/workflows` - launchers (workflows with a `portal` trigger) the caller may start
 * - `POST /api/portal/workflows/:name/start` - start one (multipart: optional `file`, `data` as a JSON string)
 *
 * Coarse access (`portal:start`) is enforced by the central authorization
 * table; visibility of individual launchers (roles) by the launcher registry,
 * which hides launchers the caller may not use (404, like a missing one).
 *
 * An uploaded file is saved under `<WORK_DIR>/uploads/portal/<uuid>/` and
 * passed to the run by its work-dir-relative path, never inline.
 *
 * @module
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { matchesAccept, type PortalWorkflowStartResult } from "@shared/portal";
import type { ResolvedPrincipal } from "@src/auth";
import { WORK_DIR } from "@src/config";
import { PortalLauncherError, type PortalLauncherRegistry, type PortalLauncherViewer } from "@src/portal";
import { validateJsonSchema } from "@src/utils/jsonSchema";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";
import { fileTypeFromBuffer } from "file-type";
import { getPrincipal } from "../../auth";

/** Work-dir-relative directory that portal uploads are saved under. */
export const PORTAL_UPLOAD_DIR = "uploads/portal";

/** Longest file name kept for a saved upload. */
const MAX_FILENAME_LENGTH = 120;

/**
 * Turns a client-supplied file name into a safe single path segment.
 *
 * @param name - The original file name
 * @returns A name without directories or unusual characters ("upload" when nothing is left)
 */
export function sanitizeUploadName(name: string): string {
  const base = path.basename(name.replaceAll("\\", "/"));
  const cleaned = base
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(-MAX_FILENAME_LENGTH);
  return cleaned || "upload";
}

/**
 * Adds every property declared by an object schema that the data lacks, as `null`.
 *
 * @param schema - The fields schema
 * @param data - The validated form data
 * @returns The data with all declared properties present
 */
export function withDeclaredFields(
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return data;
  const filled: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) filled[key] = null;
  return { ...filled, ...data };
}

/** Builds the launcher viewer for a principal. */
function viewerFor(principal: ResolvedPrincipal): PortalLauncherViewer {
  return { userId: principal.user.id, roleNames: principal.user.roles, isAdmin: principal.isAdmin };
}

/** Maps a thrown error to a response; launcher errors keep their status. */
function errorResponse(err: unknown, status: (code: number, body: unknown) => unknown) {
  if (err instanceof PortalLauncherError) return status(err.status, { error: err.message });
  log.error("Portal workflow route failed:", err);
  return status(500, { error: "Internal error" });
}

/**
 * Creates the portal workflow launcher routes.
 *
 * @param getLaunchers - Getter for the launcher registry (undefined when the portal is disabled)
 * @param workDir - Root the uploads are saved under (the agent work dir)
 * @returns Elysia plugin
 */
export function portalWorkflowRoutes(
  getLaunchers: () => PortalLauncherRegistry | undefined,
  workDir: string = WORK_DIR,
) {
  return new Elysia()
    .get("/api/portal/workflows", ({ request, status }) => {
      const launchers = getLaunchers();
      const principal = getPrincipal(request);
      if (!launchers) return status(503, { error: "Portal workflows unavailable" });
      if (!principal) return status(401, { error: "Unauthorized" });
      return status(200, launchers.list(viewerFor(principal)));
    })
    .post(
      "/api/portal/workflows/:name/start",
      async ({ params, request, status }) => {
        const launchers = getLaunchers();
        const principal = getPrincipal(request);
        if (!launchers) return status(503, { error: "Portal workflows unavailable" });
        if (!principal) return status(401, { error: "Unauthorized" });

        const def = launchers.get(params.name, viewerFor(principal));
        if (!def) return status(404, { error: "Workflow not found" });

        let form: Awaited<ReturnType<Request["formData"]>>;
        try {
          form = await request.formData();
        } catch {
          return status(400, { error: "Expected a multipart form" });
        }

        // Form fields: a JSON object, validated against the launcher's schema.
        let data: unknown = {};
        const rawData = form.get("data");
        if (typeof rawData === "string" && rawData.trim() !== "") {
          try {
            data = JSON.parse(rawData);
          } catch {
            return status(400, { error: "Field data is not valid JSON" });
          }
        }
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          return status(400, { error: "Field data must be a JSON object" });
        }
        if (def.fields) {
          const result = validateJsonSchema(def.fields, data);
          if (!result.valid) return status(422, { error: "Invalid form data", details: result.errors });
          // Optional fields left empty are omitted by the form; give them null so
          // `{{trigger.payload.data.<field>}}` resolves (to "") instead of failing.
          data = withDeclaredFields(def.fields, data as Record<string, unknown>);
        } else {
          data = {};
        }

        const upload = form.get("file");
        const file = upload instanceof Blob && upload.size > 0 ? upload : null;
        if (!file && def.fileRequired) return status(400, { error: "A file is required" });

        let fileInfo: { path: string; name: string; mimeType: string; size: number } | null = null;
        let uploadDir: string | null = null;
        if (file) {
          if (file.size > def.maxSizeMb * 1024 * 1024) {
            return status(413, { error: `The file is larger than ${def.maxSizeMb} MB` });
          }
          const name = sanitizeUploadName(file instanceof File ? file.name : "upload");
          const bytes = new Uint8Array(await file.arrayBuffer());
          // Prefer the sniffed type over the client's claim; text formats fall back to it.
          const claimed = file.type.split(";")[0]!.trim();
          const mimeType = (await fileTypeFromBuffer(bytes))?.mime ?? (claimed || "application/octet-stream");
          if (!matchesAccept(def.accept, mimeType, name)) {
            return status(415, { error: `File type ${mimeType} is not accepted`, mimeType });
          }
          const relDir = `${PORTAL_UPLOAD_DIR}/${crypto.randomUUID()}`;
          uploadDir = path.join(workDir, relDir);
          await Bun.write(path.join(uploadDir, name), bytes);
          fileInfo = { path: `${relDir}/${name}`, name, mimeType, size: file.size };
        }

        const payload = {
          file: fileInfo,
          data,
          submittedBy: {
            id: principal.user.id,
            username: principal.user.username,
            displayName: principal.user.displayName ?? null,
          },
          submittedAt: new Date().toISOString(),
        };

        try {
          const { runId } = await launchers.start(def, payload);
          log.info(`Portal: ${principal.user.username} started workflow "${def.name}" (run ${runId})`);
          const result: PortalWorkflowStartResult = { runId };
          return status(202, result);
        } catch (err) {
          if (uploadDir) await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
          return errorResponse(err, status as never);
        }
      },
      { parse: "none" },
    );
}
