/**
 * Web Fetch extension - provides the agent with the ability to fetch
 * and read webpages via a `web` sandbox command.
 *
 * This is a lightweight extension that only provides a skill with a
 * sandbox script. No HTTP routes or queues are needed since the script
 * uses Bun's built-in `fetch` directly.
 */

import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";

const manifest = {
  name: "web-fetch",
  version: "1.0.0",
  description: "Fetch and read webpages",
} satisfies ExtensionManifest;

/**
 * Creates a fresh Web Fetch extension instance.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let _logger: Logger;

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      _logger = ctx.log;
    },

    async shutdown() {},
  };
}

export default createExtension();
