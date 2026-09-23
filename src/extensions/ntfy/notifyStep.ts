/**
 * Notify (ntfy) step type handler.
 *
 * Provides a deterministic, non-LLM workflow step for sending a push
 * notification via ntfy.sh. Unlike an `agent` step that is prompted to
 * "send a notification" in natural language, this step calls the ntfy
 * publish path directly, so delivery is reliable, cheap (no token cost),
 * and testable.
 *
 * The message body, title, and topic support `{{template}}` expressions, so
 * they can pull context from the trigger payload or previous step results
 * (e.g. `{{steps.build-message.result}}`).
 *
 * The server URL and auth token never appear in workflow files: the handler
 * is constructed by the ntfy extension with a `send` function bound to the
 * extension's configured server, default topic, and (optional) access token.
 */

import { formatValidationErrors } from "@ext/sdk";
import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Allowed ntfy message priorities (1 = min ... 5 = max). */
const PRIORITY_VALUES = [1, 2, 3, 4, 5] as const;

/**
 * Curated subset of ntfy emoji tag shortcodes offered as autocomplete
 * suggestions in the workflow editor, mapped to the emoji they render as when
 * delivered (see https://docs.ntfy.sh/emojis/). The field also accepts
 * arbitrary custom tags that do not map to an emoji (via `allowCustomItems`),
 * so this is a convenience list of common notification/status tags.
 *
 * The shortcode is the value stored and sent to ntfy; the emoji is used only
 * to build a nicer display label in the editor dropdown.
 */
const SUGGESTED_EMOJI_TAGS: Record<string, string> = {
  "+1": "\uD83D\uDC4D",
  "-1": "\uD83D\uDC4E",
  bangbang: "\u203C\uFE0F",
  bell: "\uD83D\uDD14",
  boom: "\uD83D\uDCA5",
  chart_with_downwards_trend: "\uD83D\uDCC9",
  chart_with_upwards_trend: "\uD83D\uDCC8",
  computer: "\uD83D\uDCBB",
  credit_card: "\uD83D\uDCB3",
  email: "\uD83D\uDCE7",
  exclamation: "\u2757",
  eyes: "\uD83D\uDC40",
  fire: "\uD83D\uDD25",
  floppy_disk: "\uD83D\uDCBE",
  gear: "\u2699\uFE0F",
  green_circle: "\uD83D\uDFE2",
  hammer: "\uD83D\uDD28",
  heavy_check_mark: "\u2714\uFE0F",
  hourglass: "\u231B",
  inbox_tray: "\uD83D\uDCE5",
  key: "\uD83D\uDD11",
  lock: "\uD83D\uDD12",
  loudspeaker: "\uD83D\uDCE2",
  moneybag: "\uD83D\uDCB0",
  no_entry: "\u26D4",
  no_entry_sign: "\uD83D\uDEAB",
  package: "\uD83D\uDCE6",
  partying_face: "\uD83E\uDD73",
  question: "\u2753",
  red_circle: "\uD83D\uDD34",
  robot: "\uD83E\uDD16",
  rocket: "\uD83D\uDE80",
  rotating_light: "\uD83D\uDEA8",
  skull: "\uD83D\uDC80",
  sos: "\uD83C\uDD98",
  stopwatch: "\u23F1\uFE0F",
  tada: "\uD83D\uDF89",
  triangular_flag_on_post: "\uD83D\uDEA9",
  unlock: "\uD83D\uDD13",
  warning: "\u26A0\uFE0F",
  white_check_mark: "\u2705",
  wrench: "\uD83D\uDD27",
  x: "\u274C",
  yellow_circle: "\uD83D\uDFE1",
  zap: "\u26A1",
};

/** Shortcodes offered as suggestions (the values stored and sent to ntfy). */
const SUGGESTED_TAG_CODES = Object.keys(SUGGESTED_EMOJI_TAGS);

/**
 * Display-label map for the editor: shortcode -> "emoji shortcode".
 * Keeps the stored value a bare shortcode while showing the emoji alongside it.
 */
const TAG_ITEM_LABELS: Record<string, string> = Object.fromEntries(
	Object.entries(SUGGESTED_EMOJI_TAGS).map(([code, emoji]) => [code, `${emoji} ${code}`]),
);

/** TypeBox schema for the ntfy notify step configuration. */
const NotifyStepConfigSchema = Type.Object(
	{
    title: Type.Optional(
			Type.String({
				title: "Title",
				description: "Optional notification title. Supports {{template}} expressions.",
			}),
		),
		message: Type.String({
			title: "Message",
			description: "The notification body. Supports {{template}} expressions.",
			minLength: 1,
			multiline: true,
		}),
    markdown: Type.Optional(
			Type.Boolean({
				title: "Markdown",
				description:
					"Render the message body as Markdown (bold, links, lists, etc.). Currently rendered by the ntfy web app only; other clients show the raw text. Defaults to on.",
				default: true,
			}),
		),
		click: Type.Optional(
			Type.String({
				title: "Click URL",
				description:
					"URL opened when the notification is tapped (ntfy click action). Supports {{template}} expressions. Use http(s):// for a website or a scheme like mailto:, geo:, ntfy:// for deep links.",
			}),
		),
		// Modeled as a string enum ("1"-"5") because the workflow editor renders
		// enums as a <select> whose value is always a string, and keys its option
		// list by value (numeric + string literals would collide). execute()
		// normalizes the selected string to a numeric MessagePriority.
		priority: Type.Optional(
			Type.Union(
				PRIORITY_VALUES.map((p) => Type.Literal(String(p))),
				{
					title: "Priority",
					description: "Message priority from 1 (min) to 5 (max). Default: 3.",
					default: "3",
				},
			),
		),
		tags: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				title: "Tags",
				description:
					"Optional tags shown with the notification. Known emoji shortcodes (e.g. \"warning\", \"skull\") render as emoji; any other value is shown as a plain text tag.",
				// Suggestions offered by the editor's multiselect; `allowCustomItems`
				// keeps free-form entry available for tags that are not emoji.
				availableItems: SUGGESTED_TAG_CODES,
				allowCustomItems: true,
				// Display-only: shows the emoji next to each shortcode in the editor
				// dropdown. The stored/sent value remains the bare shortcode.
				itemLabels: TAG_ITEM_LABELS,
			}),
		),
    topic: Type.Optional(
			Type.String({
				title: "Topic",
				description:
					"Target ntfy topic. Supports {{template}} expressions. Uses the extension's default topic if omitted.",
			}),
		),
	},
	{ additionalProperties: false },
);

/** Configuration for a single ntfy publish call. */
export interface NtfySendConfig {
	/** The resolved notification body. */
	message: string;
	/** Optional resolved notification title. */
	title?: string;
	/** Optional resolved target topic; falls back to the extension default when omitted. */
	topic?: string;
	/** Optional URL opened when the notification is tapped (ntfy click action). */
	click?: string;
	/** When true, the message body is rendered as Markdown by supporting clients. */
	markdown?: boolean;
	/** Optional message priority (1-5). */
	priority?: (typeof PRIORITY_VALUES)[number];
	/** Optional tags/emoji shortcodes. */
	tags?: string[];
}

/** Result shape returned by the ntfy notify step. */
export interface NotifyStepResult {
	/** Always `true` when the notification was delivered (failures throw). */
	sent: true;
	/** The topic the notification was delivered to. */
	topic: string;
}

/**
 * Function that publishes a notification to an ntfy topic.
 *
 * Implemented by the ntfy extension against its configured server, default
 * topic, and optional access token. When `topic` is omitted, the
 * implementation falls back to its configured default topic and rejects if
 * none is available.
 *
 * @param config - The resolved notification configuration
 * @returns The topic the notification was delivered to
 * @throws If no topic is available or the publish fails
 */
export type NtfySendFn = (config: NtfySendConfig) => Promise<string>;

/**
 * Creates the ntfy Notify step type handler.
 *
 * @param send - Function bound to the ntfy extension that publishes the notification
 * @returns A {@link StepTypeHandler} for the `notify-ntfy` step type
 */
export function createNotifyStepHandler(send: NtfySendFn): StepTypeHandler {
	return {
		schema: NotifyStepConfigSchema,
		outputSchema: Type.Object({
			sent: Type.Boolean({ description: "Always true when the notification was delivered." }),
			topic: Type.String({ description: "The topic the notification was delivered to." }),
		}),
		label: "Notify (ntfy)",
		icon: "BroadcastIcon",

		async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<NotifyStepResult> {
			const { slug: _slug, type: _type, outputSchema: _os, ...configFields } = stepDef;

			if (!Value.Check(NotifyStepConfigSchema, configFields)) {
				const errorMsg = formatValidationErrors(NotifyStepConfigSchema, configFields);
				throw new Error(`Invalid notify-ntfy step configuration: ${errorMsg}`);
			}

			const config = configFields as {
				message: string;
				title?: string;
				topic?: string;
				click?: string;
				markdown?: boolean;
				priority?: `${(typeof PRIORITY_VALUES)[number]}`;
				tags?: string[];
			};

			// Normalize the selected priority string to a numeric MessagePriority.
			const priority =
				config.priority === undefined
					? undefined
					: (Number(config.priority) as (typeof PRIORITY_VALUES)[number]);

			// Resolve the message body template.
			const { resolved: message, warnings: messageWarnings } = await ctx.resolveTemplate(config.message);
			for (const w of messageWarnings) {
				await ctx.jobLog(`Warning (message): ${w}`);
			}

			if (message.trim().length === 0) {
				throw new Error("notify-ntfy step: resolved message is empty");
			}

			// Resolve the optional title template.
			let title: string | undefined;
			if (config.title) {
				const { resolved, warnings } = await ctx.resolveTemplate(config.title);
				for (const w of warnings) {
					await ctx.jobLog(`Warning (title): ${w}`);
				}
				title = resolved.trim() || undefined;
			}

			// Resolve the optional topic template.
			let topic: string | undefined;
			if (config.topic) {
				const { resolved, warnings } = await ctx.resolveTemplate(config.topic);
				for (const w of warnings) {
					await ctx.jobLog(`Warning (topic): ${w}`);
				}
				topic = resolved.trim() || undefined;
			}

			// Resolve the optional click URL template.
			let click: string | undefined;
			if (config.click) {
				const { resolved, warnings } = await ctx.resolveTemplate(config.click);
				for (const w of warnings) {
					await ctx.jobLog(`Warning (click): ${w}`);
				}
				click = resolved.trim() || undefined;
			}

			const deliveredTo = await send({
				message,
				title,
				topic,
				click,
				markdown: config.markdown,
				priority,
				tags: config.tags,
			});
			await ctx.jobLog(`Notification sent to topic ${deliveredTo}`);

			return { sent: true, topic: deliveredTo };
		},
	};
}
