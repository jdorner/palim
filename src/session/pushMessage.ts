/**
 * Push message type declaration for out-of-band sandbox-to-chat messaging.
 *
 * Push messages are stored in session history but excluded from LLM context.
 * They are rendered as distinct visual segments in the chat UI.
 *
 * Uses pi-agent-core's CustomAgentMessages declaration merging so that
 * push messages are recognized as valid AgentMessage instances.
 *
 * @module
 */

/**
 * A push message stored in the session history.
 *
 * Pushed by sandbox shell commands via the push endpoint. Persisted alongside
 * regular agent messages but filtered out before reaching the LLM.
 */
export interface PushMessage {
  /** Discriminator role identifying this as a push message. */
  role: "push";
  /** The message content (text or markdown). */
  content: string;
  /** MIME type indicating how to render the content. */
  contentType: "text/markdown" | "text/plain";
  /** Epoch timestamp (ms) when the push was received. */
  timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    push: PushMessage;
  }
}
