/**
 * Push message value types.
 *
 * Self-contained (no `@src`/`@shared` imports) so they can be re-exported
 * through the extension public API (`@ext/types`) without dragging the
 * push service's runtime dependencies (session store, WebSocket map) into
 * an extension's type-resolution graph.
 *
 * @module
 */

/** Options for sending a push message. */
export interface PushMessageOptions {
  /** MIME type for content rendering. Defaults to "text/markdown". */
  contentType?: "text/markdown" | "text/plain";
}

/** Result of a push message operation. */
export interface PushMessageResult {
  /** Whether the message was broadcast to an active chat or just stored. */
  status: "broadcast" | "stored";
  /** The chatId the message was broadcast to, if any. */
  chatId?: string;
}
