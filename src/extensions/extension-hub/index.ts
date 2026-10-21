/**
 * Extension Hub - install external extensions from git repositories.
 *
 * - Admins register git repositories ("sources"). A source holds one folder
 *   per extension; a folder is installable when it has an `index.ts` and a
 *   `package.json` named after the folder with a semver `version`.
 * - Releases are tags `<name>@<version>` (e.g. `imap-fetch@1.3.0`); any tag,
 *   branch, or commit can be installed as well.
 * - Installed extensions are extracted into the external extensions
 *   directory, where the directory watcher loads them. Folders the hub did not
 *   install are never touched.
 *
 * Each source is mirrored locally (bare clone) below
 * `<DATA_DIR>/extension-hub/`, so listing never needs the network. Sources
 * are fetched periodically; when the set of available updates changes, open
 * hub pages receive an `updates_changed` event. Updating stays a manual
 * action. Requires `git` and `tar` on the host.
 */

import path from "node:path";
import type { Extension, ExtensionContext, ExtensionManifest } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { requestUserId } from "@src/web/triggerOwnership";
import { PAGE_ROUTE, UPDATES_CHANGED_EVENT } from "./events";
import { HubService } from "./hub";
import { registerRoutes } from "./routes";
import { HubStore } from "./store";
import { createTokenAccess, pruneTokens } from "./tokens";

/** Default interval of the periodic update check. */
const DEFAULT_CHECK_INTERVAL_MINUTES = 360;

/** Delay of the first check after start (lets the server finish booting). */
const FIRST_CHECK_DELAY_MS = 30_000;

const manifest = {
  name: "extension-hub",
  version: "0.1.1",
  description: "Install, update, and remove external extensions from git repositories",
  ui: {
    pages: [{ id: "hub", title: "Extension Hub", entry: "ui/ExtensionHubPage.svelte" }],
    navigation: [
      {
        label: "Extension Hub",
        route: PAGE_ROUTE,
        icon: "PuzzlePieceIcon",
        order: 200,
        badgeKey: "extensionUpdateCount",
        iconColor: "text-pink-600 dark:text-pink-400",
      },
    ],
  },
  settingsSchema: Type.Object({
    includePrereleases: Type.Boolean({
      title: "Include prereleases",
      description: "Offer prerelease versions (e.g. 1.2.0-rc.1) as the latest version",
      default: false,
    }),
    checkIntervalMinutes: Type.Integer({
      title: "Update check interval (minutes)",
      description: "How often all sources are fetched to look for new versions (0 = only on demand)",
      default: DEFAULT_CHECK_INTERVAL_MINUTES,
      minimum: 0,
      maximum: 10080,
    }),
  }),
} satisfies ExtensionManifest;

/**
 * Creates a fresh Extension Hub instance.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  const timers: { first?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval> } = {};
  const clearTimers = () => {
    clearTimeout(timers.first);
    clearInterval(timers.interval);
    timers.first = undefined;
    timers.interval = undefined;
  };

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      const extensions = ctx.internal?.extensions;
      if (!extensions?.externalDir) {
        ctx.status.setWarnings(["The extension registry does not expose an external extensions directory"]);
        return;
      }

      const { getToken, setToken } = createTokenAccess(ctx.secrets);

      const hub = new HubService({
        store: new HubStore(ctx.db),
        extensions,
        workRoot: path.join(ctx.paths.data, "extension-hub"),
        log: ctx.log,
        getToken,
        setToken,
        includePrereleases: () => ctx.config.get<boolean>("INCLUDE_PRERELEASES", false),
        watchMode: process.execArgv.some((arg) => arg === "--watch" || arg === "--hot"),
      });
      await hub.init();

      try {
        const removed = await pruneTokens(ctx.secrets, new Set(hub.listSources().map((s) => s.id)));
        if (removed.length > 0) ctx.log.info(`[extension-hub] Removed ${removed.length} unused source token(s)`);
      } catch (err) {
        ctx.log.warn(`[extension-hub] Could not clean up source tokens: ${(err as Error).message}`);
      }

      // Publishes fetch errors as extension warnings and update-set changes to open pages.
      let lastSignature: string | null = null;
      const publish = () => {
        ctx.status.setWarnings(
          hub
            .listSources()
            .filter((s) => s.lastError)
            .map((s) => `Source "${s.name}" could not be fetched: ${s.lastError}`),
        );
        const updates = hub.updates();
        const signature = JSON.stringify(updates.map((u) => [u.name, u.update.commit]));
        if (signature === lastSignature) return;
        if (lastSignature !== null) {
          for (const u of updates) {
            ctx.log.info(`[extension-hub] Update available: ${u.name} ${u.installedVersion} -> ${u.update.ref}`);
          }
        }
        lastSignature = signature;
        ctx.ui.emit(UPDATES_CHANGED_EVENT, { count: updates.length, names: updates.map((u) => u.name) });
      };
      const runCheck = async () => {
        const result = await hub.check();
        publish();
        return result;
      };
      const schedule = () => {
        clearTimers();
        const minutes = ctx.config.get<number>("CHECK_INTERVAL_MINUTES", DEFAULT_CHECK_INTERVAL_MINUTES);
        if (!(minutes > 0)) return;
        const tick = () => {
          runCheck().catch((err) => ctx.log.error(`[extension-hub] Update check failed: ${(err as Error).message}`));
        };
        timers.first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
        timers.interval = setInterval(tick, minutes * 60_000);
      };

      ctx.events.on("settings:changed", (event) => {
        if ((event as { extensionName?: string }).extensionName !== manifest.name) return;
        schedule();
        publish();
      });

      registerRoutes(ctx, hub, requestUserId, {
        hasToken: async (id) => (await getToken(id)) !== null,
        runCheck,
        afterChange: publish,
      });
      publish();
      schedule();
      ctx.log.info(`[extension-hub] Ready (${hub.listSources().length} source(s))`);
    },

    async shutdown() {
      clearTimers();
    },
  };
}

export default createExtension();
