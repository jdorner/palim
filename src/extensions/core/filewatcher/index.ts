/**
 * File Watcher extension - manages configurable directory watchers that emit
 * domain events when matching files are detected, enabling file system events
 * as workflow triggers.
 *
 * Exposes:
 * - REST CRUD routes under `/ext/filewatcher`
 * - Emits `"filewatcher:detected"` events on the shared event bus
 *
 * Registrations are persisted in the shared SQLite database via Drizzle ORM.
 * All watched paths are scoped to WORK_DIR for security.
 *
 * State is encapsulated in a factory function so each call to
 * {@link createExtension} produces an isolated instance.
 */

import path from "node:path";
import { FileWatcher, formatValidationErrors } from "@ext/sdk";
import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import { Value } from "@sinclair/typebox/value";
import { CreateFileWatcherPayload, UpdateFileWatcherPayload } from "./schemas";
import {
  deleteWatcher as deleteWatcherRecord,
  findWatcher,
  initStore,
  insertWatcher,
  loadAll,
  updateWatcher,
} from "./store";
import type { FileWatcherEventType, FileWatcherRegistration } from "./types";

/**
 * Validates that a path resolves within the work directory.
 *
 * @param watchPath - Path relative to workDir (or absolute)
 * @param workDir - Absolute path to the work directory
 * @returns The resolved absolute path
 * @throws If the resolved path escapes workDir
 */
function validateAndResolvePath(watchPath: string, workDir: string): string {
  const resolved = path.isAbsolute(watchPath) ? watchPath : path.resolve(workDir, watchPath);
  const workDirResolved = path.resolve(workDir);
  if (!resolved.startsWith(workDirResolved + path.sep) && resolved !== workDirResolved) {
    throw new Error(`Path "${watchPath}" resolves outside WORK_DIR`);
  }
  return resolved;
}

/**
 * Checks whether a filename matches any of the given glob patterns.
 *
 * @param filename - The filename to test (basename only)
 * @param patterns - Array of glob patterns
 * @returns True if any pattern matches
 */
function matchesPatterns(filename: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    if (glob.match(filename)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const manifest = {
  name: "filewatcher",
  version: "1.0.0",
  description: "Configurable directory watchers that emit events on file changes",
  dependencies: [],
  core: true,
  ui: {
    navigation: [
      {
        label: "File Watchers",
        route: "/filewatchers",
        icon: "EyeIcon",
        order: 80,
        badgeKey: "fileWatcherCount",
        iconColor: "text-amber-500 dark:text-amber-300",
      },
    ],
  },
} satisfies ExtensionManifest;

/**
 * Creates a fresh File Watcher extension instance with its own encapsulated state.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let logger: Logger;
  const activeWatchers = new Map<string, FileWatcher>();

  /**
   * Starts a FileWatcher for the given registration and wires up event emission.
   *
   * @param registration - The watcher configuration
   * @param ctx - Extension context for event emission
   */
  async function startWatcher(registration: FileWatcherRegistration, ctx: ExtensionContext): Promise<void> {
    const resolvedPath = validateAndResolvePath(registration.path, ctx.workDir);

    const watcher = new FileWatcher(resolvedPath, {
      recursive: registration.recursive,
      processExistingOnStart: registration.processExisting,
    });

    const subscribedEvents = new Set<FileWatcherEventType>(registration.events);

    /**
     * Validates that an absolute file path is within workDir and returns the relative path.
     * Returns undefined if the path escapes workDir.
     */
    function validateAndEmit(filePath: string, event: FileWatcherEventType): void {
      const basename = path.basename(filePath);
      if (!matchesPatterns(basename, registration.patterns)) return;

      // Chokidar emits absolute paths. Validate they stay within workDir.
      const workDirPrefix = ctx.workDir.endsWith(path.sep) ? ctx.workDir : ctx.workDir + path.sep;
      if (!filePath.startsWith(workDirPrefix) && filePath !== ctx.workDir) {
        logger.warn(`File watcher "${registration.slug}": path "${filePath}" escapes WORK_DIR, ignoring`);
        return;
      }

      const relativePath = path.relative(ctx.workDir, filePath);
      logger.debug(`File watcher "${registration.slug}": ${event} "${relativePath}"`);
      ctx.emitEvent({
        type: "filewatcher:detected",
        context: {
          source: "filewatcher",
          id: registration.slug,
          slug: registration.slug,
          filename: relativePath,
          event,
        },
      });
    }

    if (subscribedEvents.has("new")) {
      watcher.on("new", (filePath) => validateAndEmit(filePath, "new"));
    }

    if (subscribedEvents.has("change")) {
      watcher.on("change", (filePath) => validateAndEmit(filePath, "change"));
    }

    if (subscribedEvents.has("delete")) {
      watcher.on("delete", (filePath) => validateAndEmit(filePath, "delete"));
    }

    await watcher.start();
    activeWatchers.set(registration.slug, watcher);
    logger.info(
      `Started file watcher "${registration.slug}" on "${resolvedPath}" (patterns: ${registration.patterns.join(", ")}, events: ${registration.events.join(", ")})`,
    );
  }

  /**
   * Stops and removes the active FileWatcher for the given slug.
   *
   * @param slug - The watcher slug to stop
   */
  async function stopWatcher(slug: string): Promise<void> {
    const watcher = activeWatchers.get(slug);
    if (watcher) {
      await watcher.close();
      activeWatchers.delete(slug);
      logger.info(`Stopped file watcher "${slug}"`);
    }
  }

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;
      initStore(ctx.getDatabase());

      // Load registrations and start enabled watchers
      const watchers = loadAll();
      logger.info(`Loaded ${watchers.length} file watcher registration(s)`);

      for (const registration of watchers) {
        if (!registration.enabled) continue;
        try {
          await startWatcher(registration, ctx);
        } catch (err) {
          logger.error(`Failed to start watcher "${registration.slug}":`, err);
        }
      }

      // ---------------------------------------------------------------
      // GET /ext/filewatcher/
      // ---------------------------------------------------------------
      ctx.registerRoute("GET", "/", async () => {
        return Response.json(loadAll());
      });

      // ---------------------------------------------------------------
      // POST /ext/filewatcher/
      // ---------------------------------------------------------------
      ctx.registerRoute("POST", "/", async (reqCtx) => {
        const body = reqCtx.body as Record<string, unknown>;
        if (!Value.Check(CreateFileWatcherPayload, body)) {
          return Response.json(
            { error: `Validation failed: ${formatValidationErrors(CreateFileWatcherPayload, body)}` },
            { status: 400 },
          );
        }

        // Validate path scoping
        try {
          validateAndResolvePath(body.path as string, ctx.workDir);
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }

        if (findWatcher(body.slug as string)) {
          return Response.json({ error: `File watcher "${body.slug}" already exists` }, { status: 409 });
        }

        const registration: FileWatcherRegistration = {
          slug: body.slug as string,
          name: body.name as string,
          path: body.path as string,
          patterns: body.patterns as string[],
          recursive: (body.recursive as boolean | undefined) ?? false,
          processExisting: (body.processExisting as boolean | undefined) ?? false,
          events: (body.events as FileWatcherEventType[] | undefined) ?? ["new"],
          enabled: (body.enabled as boolean | undefined) ?? true,
          createdAt: Date.now(),
        };

        insertWatcher(registration);

        if (registration.enabled) {
          try {
            await startWatcher(registration, ctx);
          } catch (err) {
            logger.error(`Failed to start watcher "${registration.slug}" after create:`, err);
          }
        }

        ctx.broadcast({ type: "filewatcher_reload" });
        logger.info(`Created file watcher "${registration.slug}"`);
        return Response.json(registration, { status: 201 });
      });

      // ---------------------------------------------------------------
      // PUT /ext/filewatcher/:slug
      // ---------------------------------------------------------------
      ctx.registerRoute("PUT", "/:slug", async (reqCtx) => {
        const slug = (reqCtx.params as Record<string, string>).slug;
        if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

        const body = reqCtx.body as Record<string, unknown>;
        if (!Value.Check(UpdateFileWatcherPayload, body)) {
          return Response.json(
            { error: `Validation failed: ${formatValidationErrors(UpdateFileWatcherPayload, body)}` },
            { status: 400 },
          );
        }

        // Validate new path if provided
        if (body.path !== undefined) {
          try {
            validateAndResolvePath(body.path as string, ctx.workDir);
          } catch (err) {
            return Response.json({ error: (err as Error).message }, { status: 400 });
          }
        }

        const updates = body as Partial<FileWatcherRegistration>;
        const updated = updateWatcher(slug, updates);
        if (!updated) return Response.json({ error: "Not found" }, { status: 404 });

        // Restart watcher with updated config
        await stopWatcher(slug);
        if (updated.enabled) {
          try {
            await startWatcher(updated, ctx);
          } catch (err) {
            logger.error(`Failed to restart watcher "${slug}" after update:`, err);
          }
        }

        ctx.broadcast({ type: "filewatcher_reload" });
        logger.info(`Updated file watcher "${slug}"`);
        return Response.json(updated);
      });

      // ---------------------------------------------------------------
      // DELETE /ext/filewatcher/:slug
      // ---------------------------------------------------------------
      ctx.registerRoute("DELETE", "/:slug", async (reqCtx) => {
        const slug = (reqCtx.params as Record<string, string>).slug;
        if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

        if (!deleteWatcherRecord(slug)) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }

        await stopWatcher(slug);

        ctx.broadcast({ type: "filewatcher_reload" });
        logger.info(`Deleted file watcher "${slug}"`);
        return Response.json({ ok: true });
      });
    },

    async shutdown() {
      for (const slug of activeWatchers.keys()) {
        await stopWatcher(slug);
      }
    },
  };
}

export default createExtension();
