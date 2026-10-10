/**
 * Server-sent events over `fetch`, so the bearer token can be sent as a
 * header (`EventSource` cannot). Reconnects with exponential backoff.
 *
 * @module
 */

import { getToken } from "./api";
import { apiUrl } from "./config";

/** A parsed SSE message. */
export interface SseMessage {
  /** The `event:` field ("message" when absent). */
  event: string;
  /** The joined `data:` lines. */
  data: string;
}

/**
 * Creates an incremental SSE parser. Feed it decoded text chunks in order;
 * it calls `onMessage` for every complete message. Comments (`: ping`) and
 * messages without data are skipped.
 *
 * @param onMessage - Called per message
 * @returns The chunk consumer
 */
export function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) onMessage({ event, data: data.join("\n") });
    }
  };
}

/** Options for {@link openEventStream}. */
export interface EventStreamOptions {
  /** Called per message. */
  onMessage: (message: SseMessage) => void;
  /** Called when the connection state changes. */
  onStatus?: (connected: boolean) => void;
  /** Called on 401/403 (the stream is not retried). */
  onDenied?: (status: number) => void;
}

/**
 * Opens an authenticated event stream that reconnects until closed.
 *
 * @param path - API path of the stream
 * @param options - Callbacks
 * @returns A function that closes the stream
 */
export function openEventStream(path: string, options: EventStreamOptions): () => void {
  let closed = false;
  let controller: AbortController | null = null;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    try {
      const token = getToken();
      const res = await fetch(apiUrl(path), {
        headers: { Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        options.onDenied?.(res.status);
        return;
      }
      if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`);

      options.onStatus?.(true);
      delay = 1000;
      const parse = createSseParser(options.onMessage);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parse(value);
      }
    } catch {
      // Network error or abort; reconnect below unless closed.
    }
    options.onStatus?.(false);
    if (!closed) {
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }

  void connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
}
