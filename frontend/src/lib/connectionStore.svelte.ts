/**
 * Centralized WebSocket connection lifecycle management.
 *
 * Encapsulates connect, disconnect, reconnect, and post-connection
 * data fetching in a single reactive store. Replaces the scattered
 * connection logic previously spread across App.svelte, appStore, and auth.
 */

import type { WebSocketMessage } from "../../../shared/types";
import { buildWsConnection, connected, hasConnected } from "./appStore";
import { forceLogout } from "./auth";
import { chatStream } from "./chatStreamStore.svelte";
import { fetchBadgesForEnabledExtensions, fetchExtensions } from "./extensionStore";
import { modelStore } from "./modelStore.svelte";

const MAX_RECONNECT_DELAY = 30000;

/**
 * Reactive connection state manager exposed as a Svelte 5 class.
 * A single module-level instance (`connectionManager`) is exported.
 */
class ConnectionManager {
  /** The active WebSocket instance, or null when disconnected. */
  private ws: WebSocket | null = null;
  /** Pending reconnect timer handle. */
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Current exponential backoff delay in milliseconds. */
  private reconnectDelay = 1000;
  /** External message handler set by the consumer (App.svelte). */
  private messageHandler: ((message: WebSocketMessage) => void) | null = null;
  /** Whether disconnect was intentional (suppresses reconnect). */
  private intentionalDisconnect = false;

  /**
   * Registers the handler that processes incoming WebSocket messages.
   * Must be called before `connect()`.
   * @param handler - Callback invoked with each parsed WebSocket message.
   */
  onMessage(handler: (message: WebSocketMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Opens the WebSocket connection and triggers initial data fetching
   * once connected. Safe to call multiple times (no-ops if already connected).
   */
  connect(): void {
    if (this.ws) return;
    this.intentionalDisconnect = false;

    const { url, protocols } = buildWsConnection();
    const socket = new WebSocket(url, protocols);
    this.ws = socket;

    // Events from a superseded socket (closed via disconnect() or replaced by a
    // reconnect) are ignored, so a late close can't clobber the current socket
    // and a lingering socket can't deliver duplicate messages.
    socket.onopen = () => {
      if (this.ws !== socket) return;
      connected.set(true);
      hasConnected.set(true);
      this.reconnectDelay = 1000;
      this.fetchInitialData();
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      connected.set(false);
      this.ws = null;
      chatStream.handleWsClose();

      if (event.code === 4001) {
        forceLogout();
        return;
      }

      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = (error) => {
      if (this.ws !== socket) return;
      connected.set(false);
      console.error("WebSocket error:", error);
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      try {
        const message = JSON.parse(event.data);
        this.messageHandler?.(message);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };
  }

  /**
   * Closes the WebSocket connection and cancels any pending reconnect.
   * Use this on logout or when the connection should be torn down intentionally.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      const socket = this.ws;
      // Detach first: the socket's own close handler ignores superseded sockets.
      this.ws = null;
      socket.close();
      chatStream.handleWsClose();
    }
    connected.set(false);
  }

  /** Whether a WebSocket instance currently exists. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Fetches all initial data needed after a successful connection.
   * Called on every successful (re)connect so state stays fresh.
   */
  private async fetchInitialData(): Promise<void> {
    fetchExtensions().then(() => {
      fetchBadgesForEnabledExtensions();
    });
    modelStore.refresh();
    chatStream.loadConversations();
  }

  /** Schedules a reconnect attempt with exponential backoff. */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;
    console.info(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, this.reconnectDelay);
  }
}

/** Singleton connection manager instance. */
export const connectionManager = new ConnectionManager();
