/**
 * Notify (Telegram) step type handler.
 *
 * Provides a deterministic, non-LLM workflow step for sending a Telegram
 * message. Unlike an `agent` step that is prompted to "send a notification"
 * in natural language, this step calls the Telegram send path directly, so
 * delivery is reliable, cheap (no token cost), and testable.
 *
 * The message body and target chat ID support `{{template}}` expressions, so
 * they can pull context from the trigger payload or previous step results
 * (e.g. `{{steps.build-message.result}}`).
 *
 * The bot token never appears in workflow files: the handler is constructed by
 * the telegram extension with a `send` function bound to the extension's live,
 * reconnect-aware bot instance and configured default chat ID.
 */

import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";

/** TypeBox schema for the notify step configuration. */
const NotifyStepConfigSchema = Type.Object(
  {
    message: Type.String({
      title: "Message",
      description: "The message text to send. Supports {{template}} expressions.",
      minLength: 1,
      multiline: true,
    }),
    chatId: Type.Optional(
      Type.String({
        title: "Chat ID",
        description:
          "Target Telegram chat ID. Supports {{template}} expressions. Uses the extension's default chat if omitted.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Result shape returned by the notify step. */
export interface NotifyStepResult {
  /** Always `true` when the message was delivered (failures throw). */
  sent: true;
  /** The chat ID the message was delivered to. */
  chatId: string;
}

/**
 * Function that delivers a message to a Telegram chat.
 *
 * Implemented by the telegram extension against its live bot instance. When
 * `chatId` is omitted, the implementation falls back to its configured default
 * chat ID and rejects if none is available.
 *
 * @param message - The resolved message text to send
 * @param chatId - Optional resolved target chat ID
 * @returns The chat ID the message was delivered to
 * @throws If no chat ID is available or the send fails
 */
export type TelegramSendFn = (message: string, chatId?: string) => Promise<string>;

/**
 * Creates the Notify step type handler.
 *
 * @param send - Function bound to the telegram extension's bot that delivers the message
 * @returns A {@link StepTypeHandler} for the `notify` step type
 */
export function createNotifyStepHandler(send: TelegramSendFn): StepTypeHandler {
  return {
    schema: NotifyStepConfigSchema,
    label: "Notify (Telegram)",
    icon: "PaperPlaneTiltIcon",

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<NotifyStepResult> {
      const { slug: _slug, type: _type, outputSchema: _os, ...configFields } = stepDef;

      if (!Value.Check(NotifyStepConfigSchema, configFields)) {
        const errorMsg = formatValidationErrors(NotifyStepConfigSchema, configFields);
        throw new Error(`Invalid notify step configuration: ${errorMsg}`);
      }

      const config = configFields as { message: string; chatId?: string };

      // Resolve the message body template.
      const { resolved: message, warnings: messageWarnings } = await ctx.resolveTemplate(config.message);
      for (const w of messageWarnings) {
        await ctx.jobLog(`Warning (message): ${w}`);
      }

      if (message.trim().length === 0) {
        throw new Error("notify step: resolved message is empty");
      }

      // Resolve the optional chat ID template.
      let chatId: string | undefined;
      if (config.chatId) {
        const { resolved, warnings } = await ctx.resolveTemplate(config.chatId);
        for (const w of warnings) {
          await ctx.jobLog(`Warning (chatId): ${w}`);
        }
        chatId = resolved.trim() || undefined;
      }

      const deliveredTo = await send(message, chatId);
      await ctx.jobLog(`Notification sent to chat ${deliveredTo}`);

      return { sent: true, chatId: deliveredTo };
    },
  };
}
