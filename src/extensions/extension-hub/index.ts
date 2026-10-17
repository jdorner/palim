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
 * `<DATA_DIR>/extension-hub/`, so listing never needs the network. Requires
 * `git` and `tar` on the host.
 */

import path from "node:path";
import type { Extension, ExtensionContext, ExtensionManifest } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { requestUserId } from "@src/web/triggerOwnership";
import { HubError } from "./errors";
import { HubService } from "./hub";
import { registerRoutes } from "./routes";
import { HubStore } from "./store";

const manifest = {
  name: "extension-hub",
  version: "0.1.0",
  description: "Install, update, and remove external extensions from git repositories",
  settingsSchema: Type.Object({
    includePrereleases: Type.Boolean({
      title: "Include prereleases",
      description: "Offer prerelease versions (e.g. 1.2.0-rc.1) as the latest version",
      default: false,
    }),
  }),
} satisfies ExtensionManifest;

/** Secret key holding a source's HTTPS token. */
function tokenKey(sourceId: string): string {
  return `SOURCE_TOKEN_${sourceId}`;
}

/**
 * Creates a fresh Extension Hub instance.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      const extensions = ctx.internal?.extensions;
      if (!extensions?.externalDir) {
        ctx.status.setWarnings(["The extension registry does not expose an external extensions directory"]);
        return;
      }

      const getToken = async (sourceId: string) => {
        try {
          return (await ctx.secrets.get(tokenKey(sourceId))) || null;
        } catch {
          return null;
        }
      };
      const setToken = async (sourceId: string, token: string | null) => {
        try {
          await ctx.secrets.set(tokenKey(sourceId), token ?? "");
        } catch (err) {
          if (token) {
            throw new HubError(503, `Storing the token needs the secret vault: ${(err as Error).message}`);
          }
        }
      };

      const hub = new HubService({
        store: new HubStore(ctx.db),
        extensions,
        workRoot: path.join(ctx.paths.data, "extension-hub"),
        log: ctx.log,
        getToken,
        setToken,
        includePrereleases: () => ctx.config.get<boolean>("INCLUDE_PRERELEASES", false),
      });
      await hub.init();

      registerRoutes(ctx, hub, requestUserId, async (id) => (await getToken(id)) !== null);
      ctx.log.info(`[extension-hub] Ready (${hub.listSources().length} source(s))`);
    },

    async shutdown() {},
  };
}

export default createExtension();
