/**
 * ntfy extension - sends push notifications via ntfy.sh (or a self-hosted
 * ntfy server) by POSTing to the ntfy HTTP API.
 *
 * The extension exposes a single deterministic workflow step type,
 * `notify-ntfy`, that publishes a notification to a topic. State (server URL,
 * and the secret-backed default topic and optional access token) is
 * encapsulated in a factory function so each call to {@link createExtension}
 * produces an isolated instance, making the extension easier to test and
 * reason about.
 *
 * Unlike the telegram extension, this does not register an agent tool (yet):
 * notifications are sent through the workflow step type only.
 */

import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { createNotifyStepHandler, type NtfySendConfig } from "./notifyStep";

/** Default ntfy server used when no `server` setting is configured. */
const DEFAULT_SERVER = "https://ntfy.sh";

/** Secret key holding an optional ntfy access token (Bearer) for protected topics. */
const NTFY_ACCESS_TOKEN = "NTFY_ACCESS_TOKEN" as const;

/**
 * Secret key holding the default ntfy topic. Stored as a secret rather than a
 * plain setting because a topic name is effectively a shared credential: on an
 * unauthenticated server, anyone who knows the topic can read and publish to
 * it, so it should not be exposed in plain settings or workflow files.
 */
const NTFY_DEFAULT_TOPIC = "NTFY_DEFAULT_TOPIC" as const;

const manifest = {
	name: "ntfy",
	version: "1.0.0",
	description: "Send push notifications via ntfy.sh, exposed as a workflow step type",
	dependencies: ["workflows"],
	settingsSchema: Type.Object({
		server: Type.Optional(
			Type.String({
				title: "ntfy Server URL",
				description: "Base URL of the ntfy server. Defaults to https://ntfy.sh when omitted.",
				default: DEFAULT_SERVER,
			}),
		),
	}),
	secretsSchema: [
		{
			key: NTFY_ACCESS_TOKEN,
			description: "Optional ntfy access token (Bearer) for publishing to protected topics",
			required: false,
		},
		{
			key: NTFY_DEFAULT_TOPIC,
			description:
				"Default ntfy topic used when a step does not specify one. Treated as a secret because the topic name grants read/publish access on unauthenticated servers.",
			required: false,
		},
	],
} satisfies ExtensionManifest;

/**
 * Reads a config value and coerces it to a trimmed string, or undefined when
 * absent/empty.
 *
 * @param ctx - The extension context
 * @param key - The config key (UPPER_SNAKE_CASE)
 * @returns The trimmed string value, or undefined
 */
function readStringConfig(ctx: ExtensionContext, key: string): string | undefined {
	const raw = ctx.config.get(key);
	if (raw == null) return undefined;
	const str = String(raw).trim();
	return str.length > 0 ? str : undefined;
}

/**
 * Creates a fresh ntfy extension instance with its own encapsulated state.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
	let logger: Logger;
	let server: string = DEFAULT_SERVER;
	let defaultTopic: string | undefined;
	let accessToken: string | null = null;

	return {
		manifest,

		async initialize(ctx: ExtensionContext) {
			logger = ctx.log;

			server = readStringConfig(ctx, "SERVER") ?? DEFAULT_SERVER;
			accessToken = await ctx.secrets.get(NTFY_ACCESS_TOKEN);
			const rawDefaultTopic = await ctx.secrets.get(NTFY_DEFAULT_TOPIC);
			defaultTopic = rawDefaultTopic?.trim() || undefined;

			/**
			 * Publishes a notification to an ntfy topic using the configured
			 * server and optional access token.
			 *
			 * Shared by the `notify-ntfy` workflow step type. The server URL and
			 * access token stay encapsulated (never templated into workflow files).
			 *
			 * @param config - The resolved notification configuration
			 * @returns The topic the notification was delivered to
			 * @throws If no topic is available or the publish fails
			 */
			async function sendNtfyNotification(config: NtfySendConfig): Promise<string> {
				const targetTopic = config.topic || defaultTopic;

				if (!targetTopic) {
					throw new Error("No topic provided and no default topic configured.");
				}

				// Publish via a direct POST rather than the `ntfy` package's client.
				// The package (v1.15.4) does not emit an X-Click header for its
				// `clickURL` field, so click actions were silently dropped. Building
				// the request here lets us set X-Click (and the other headers) and
				// keeps behavior explicit.
				//
				// ntfy maps: title -> X-Title, priority -> X-Priority, tags -> X-Tags
				// (comma-separated), click URL -> X-Click, markdown -> X-Markdown. The
				// message is the request body (UTF-8). Header values must be
				// ASCII/latin-1, so only the body carries arbitrary Unicode.
				const headers: Record<string, string> = {};
				if (config.title) headers["X-Title"] = config.title;
				if (config.click) headers["X-Click"] = config.click;
				if (config.markdown) headers["X-Markdown"] = "true";
				if (config.priority) headers["X-Priority"] = String(config.priority);
				if (config.tags && config.tags.length > 0) headers["X-Tags"] = config.tags.join(",");
				if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

				const url = new URL(encodeURIComponent(targetTopic), server.endsWith("/") ? server : `${server}/`);

				const response = await fetch(url.href, {
					method: "POST",
					headers,
					body: config.message,
				});

				if (!response.ok) {
					const detail = await response.text().catch(() => "");
					throw new Error(
						`ntfy publish failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
					);
				}

				return targetTopic;
			}

			// Register the `notify-ntfy` workflow step type: a deterministic ntfy
			// publish that keeps the server URL and token encapsulated.
			ctx.stepTypes.register("notify-ntfy", createNotifyStepHandler(sendNtfyNotification));

			// Re-read the server when extension settings change.
			ctx.events.on("settings:changed", (event) => {
				if (!("extensionName" in event) || event.extensionName !== "ntfy") return;

				const values = (event as { values?: Record<string, unknown> }).values;

				const rawServer = values?.server;
				const newServer = rawServer != null && String(rawServer).trim().length > 0 ? String(rawServer).trim() : DEFAULT_SERVER;
				if (newServer !== server) {
					server = newServer;
					logger.info(`ntfy server updated (${server})`);
				}
			});

			// Re-read the access token and default topic when a secret is updated
			// or deleted. Both are stored in the secret vault.
			ctx.events.on("secrets:changed", async (event) => {
				if (!("extensionName" in event) || event.extensionName !== "ntfy") return;

				const { updatedKeys, deletedKeys } = event as { updatedKeys: string[]; deletedKeys: string[] };

				if (deletedKeys.includes(NTFY_ACCESS_TOKEN)) {
					accessToken = null;
					logger.info("ntfy access token cleared");
				} else if (updatedKeys.includes(NTFY_ACCESS_TOKEN)) {
					accessToken = await ctx.secrets.get(NTFY_ACCESS_TOKEN);
					logger.info("ntfy access token updated");
				}

				if (deletedKeys.includes(NTFY_DEFAULT_TOPIC)) {
					defaultTopic = undefined;
					logger.info("ntfy default topic cleared");
				} else if (updatedKeys.includes(NTFY_DEFAULT_TOPIC)) {
					const raw = await ctx.secrets.get(NTFY_DEFAULT_TOPIC);
					defaultTopic = raw?.trim() || undefined;
					logger.info(`ntfy default topic ${defaultTopic ? `updated (${defaultTopic})` : "cleared"}`);
				}
			});

			logger.info(
				`ntfy extension initialized (server: ${server}${defaultTopic ? `, default topic: ${defaultTopic}` : ", no default topic"})`,
			);
		},

		async shutdown() {
			// No long-lived resources to clean up (publish uses short-lived clients).
		},
	};
}

export default createExtension();
