/**
 * Contract between the Palim web app and extension UI pages.
 *
 * An extension page is a Svelte component compiled by the backend. The host app
 * mounts it and passes a {@link PalimHost} as the `palim` prop. Everything the
 * page needs from the app (API calls, server events, theme, identity,
 * navigation, notifications) goes through this object, because the page runs
 * with its own Svelte runtime and cannot share stores or context with the host.
 *
 * @module
 */

import type { AppAction, AppSubject } from "./auth";

/** Severity of a host notification. */
export type PalimNotifyKind = "info" | "success" | "error";

/** Options for {@link PalimHost.confirm}. */
export interface PalimConfirmOptions {
  /** Dialog title. */
  title: string;
  /** Dialog body text. */
  message: string;
  /** Label of the confirm button (default "Confirm"). */
  confirmLabel?: string;
  /** Render the confirm button as destructive. */
  destructive?: boolean;
}

/** Route state of an extension page (see {@link PalimHost.page}). */
export interface PalimPageRoute {
  /** Sub-path below the page route (`""` or e.g. `"accounts/work"`). */
  path: string;
  /** Query parameters. */
  query: URLSearchParams;
}

/** Request options for {@link PalimHost.json}; `body` is JSON-encoded. */
export interface PalimJsonInit extends Omit<RequestInit, "body"> {
  /** Request payload, sent as JSON. */
  body?: unknown;
}

/** The host API handed to every extension page as its `palim` prop. */
export interface PalimHost {
  /** The extension that owns the page. */
  readonly extension: { readonly name: string; readonly version: string };

  /**
   * The page being rendered. Also a Svelte store: `$page` re-renders when the
   * sub-path or query changes (pages run their own Svelte runtime, so host
   * state is exposed through subscriptions rather than runes).
   */
  readonly page: {
    /** Page id from the manifest. */
    readonly id: string;
    /** Current sub-path below the page route (`""` or e.g. `"accounts/work"`), for in-page routing. */
    readonly path: string;
    /** Current query parameters of the route. */
    readonly query: URLSearchParams;
    /**
     * Subscribes to route changes within the page; the callback is invoked immediately.
     *
     * @param callback - Receives the current sub-path and query
     * @returns Unsubscribe function
     */
    subscribe(callback: (route: PalimPageRoute) => void): () => void;
  };

  /**
   * Authenticated fetch. Paths starting with `/api/` or `/ext/` are used as is;
   * any other path is relative to the extension's routes (`"/accounts"` →
   * `/ext/<name>/accounts`). A 401 logs the user out.
   *
   * @param path - Request path
   * @param init - Fetch options
   * @returns The response
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;

  /**
   * Authenticated JSON request (same path rules as {@link PalimHost.fetch}).
   *
   * @param path - Request path
   * @param init - Fetch options; `body` is JSON-encoded
   * @returns The parsed response body
   * @throws {Error} On a non-2xx response, with the body's `error` message when present
   */
  json<T = unknown>(path: string, init?: PalimJsonInit): Promise<T>;

  /**
   * Subscribes to events the extension emits server-side with `ctx.ui.emit()`.
   *
   * @param handler - Called with the event name and payload
   * @returns Unsubscribe function
   */
  onEvent(handler: (event: string, data: unknown) => void): () => void;

  /** Current color theme. Also a Svelte store: `$theme` is `true` in dark mode. */
  readonly theme: {
    /** Whether dark mode is active. */
    readonly dark: boolean;
    /**
     * Subscribes to theme changes; the callback is invoked immediately.
     *
     * @param callback - Receives `true` in dark mode
     * @returns Unsubscribe function
     */
    subscribe(callback: (dark: boolean) => void): () => void;
  };

  /** The signed-in user. */
  readonly user: {
    /** Login name. */
    readonly username: string;
    /** Display name, falling back to the username. */
    readonly displayName: string;
    /**
     * Checks a permission (UI gating only; the server enforces).
     *
     * @param action - The action
     * @param subject - The resource type
     * @returns True when allowed
     */
    can(action: AppAction, subject: AppSubject): boolean;
  };

  /**
   * Navigates the app (e.g. `"/workflows"`, or a sub-path of this page via
   * `"/ext-page/<name>/<page>/<sub>"`).
   *
   * @param path - App route
   */
  navigate(path: string): void;

  /**
   * Shows a transient notification in the app shell.
   *
   * @param message - Text to show
   * @param kind - Severity (default "info")
   */
  notify(message: string, kind?: PalimNotifyKind): void;

  /**
   * Asks the user to confirm an action in a host dialog.
   *
   * @param options - Dialog content
   * @returns True when confirmed
   */
  confirm(options: PalimConfirmOptions): Promise<boolean>;
}

/**
 * Default export of a compiled extension page module: mounts the page into
 * `target` (an `HTMLElement`; typed structurally because shared code is also
 * compiled without the DOM lib) and returns a function that unmounts it.
 */
export type MountExtensionPage = (target: object, palim: PalimHost) => () => void;

/** WebSocket event carrying an extension's `ctx.ui.emit()` payload. */
export interface ExtensionUiEvent {
  type: "extension_ui_event";
  /** Emitting extension name. */
  extension: string;
  /** Event name chosen by the extension. */
  event: string;
  /** Event payload (JSON-serializable). */
  data?: unknown;
}
