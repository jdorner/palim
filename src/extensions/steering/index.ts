import type { Extension, ExtensionManifest } from "@ext/types";
import { Type } from "@sinclair/typebox";

const DEFAULT_STEERING_PROMPT = `Your name is Palim, a helpful AI agent.`;

const manifest = {
  name: "steering",
  version: "1.0.0",
  description: "Injects additional system prompt text before each agent run to steer behavior or enforce constraints.",
  settingsSchema: Type.Object({
    prompt: Type.String({
      title: "Additional Prompt",
      description: "Text that is injected to the end of the system prompt",
      default: DEFAULT_STEERING_PROMPT,
      multiline: true,
    }),
  }),
} satisfies ExtensionManifest;

export default {
  manifest,

  async initialize(ctx) {
    ctx.on("before_agent_start", (event) => {
      let prompt = ctx.getConfig("PROMPT");

      if (!prompt) {
        prompt = DEFAULT_STEERING_PROMPT;
      }

      event.systemPrompt += `\n\n${prompt}`;
    });
  },
  async shutdown() {},
} satisfies Extension;
