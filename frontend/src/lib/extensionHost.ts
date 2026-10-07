/**
 * Host side of the extension page contract: builds the {@link PalimHost} object
 * handed to a mounted extension page, and routes `extension_ui_event` WebSocket
 * messages to the pages of the emitting extension.
 *
 * Extension pages run their own Svelte runtime, so host state they can observe
 * (theme, route) is exposed as minimal Svelte stores (`subscribe` returning an
 * unsubscribe function) instead of runes.
 *
 * @module
 */

import { get } from "svelte/store";
import type { AppAction, AppSubject } from "$shared/auth";
import type {
  ExtensionUiEvent,
  PalimConfirmOptions,
  PalimHost,
  PalimJsonInit,
  PalimNotifyKind,
  PalimPageRoute,
} from "$shared/extensionUi";
import { navigate, pathname } from "../router";
import { authFetch } from "./auth";
import { parsePageRoute, resolveExtensionPath } from "./extensionRoutes";
import { responseError } from "./http";
import { identity } from "./identity.svelte";

type UiEventHandler = (event: string, data: unknown) => void;

/** Page event handlers per extension name. */
const uiEventHandlers = new Map<string, Set<UiEventHandler>>();

/**
 * Delivers an `extension_ui_event` WebSocket message to the emitting
 * extension's subscribed pages. A throwing handler does not affect others.
 *
 * @param message - The WebSocket event
 */
export function dispatchExtensionUiEvent(message: ExtensionUiEvent): void {
  for (const handler of uiEventHandlers.get(message.extension) ?? []) {
    try {
      handler(message.event, message.data);
    } catch (err) {
      console.error(`Extension "${message.extension}" page failed to handle event "${message.event}":`, err);
    }
  }
}

/** A minimal Svelte-compatible store with an immediate-call `subscribe`. */
interface Signal<T> {
  get(): T;
  set(value: T): void;
  subscribe(callback: (value: T) => void): () => void;
}

/**
 * Creates a {@link Signal}.
 *
 * @param initial - Initial value
 * @param equals - Change detection (default `Object.is`)
 * @returns The signal
 */
function createSignal<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): Signal<T> {
  let value = initial;
  const subscribers = new Set<(value: T) => void>();
  return {
    get: () => value,
    set(next) {
      if (equals(value, next)) return;
      value = next;
      for (const callback of subscribers) callback(value);
    },
    subscribe(callback) {
      subscribers.add(callback);
      callback(value);
      return () => subscribers.delete(callback);
    },
  };
}

/** Inputs for {@link createPalimHost}. */
export interface PalimHostOptions {
  /** Owning extension. */
  extension: { name: string; version: string };
  /** Page id. */
  pageId: string;
  /** Page base route (`/ext-page/<ext>/<page>`), used to derive the sub-path. */
  pageRoute: string;
  /** Shows a notification in the page shell. */
  notify: (message: string, kind: PalimNotifyKind) => void;
  /** Opens the host confirm dialog. */
  confirm: (options: PalimConfirmOptions) => Promise<boolean>;
}

/**
 * Creates the host object for one mounted extension page.
 *
 * @param options - Extension, page, and shell callbacks
 * @returns The host and a `dispose` function that releases its subscriptions
 */
export function createPalimHost(options: PalimHostOptions): { host: PalimHost; dispose: () => void } {
  const { extension, pageId, pageRoute } = options;
  const cleanups: Array<() => void> = [];
  const ownHandlers = new Set<UiEventHandler>();

  // Theme: tracks the `dark` class the ThemeToggle sets on <html>.
  const isDark = () => document.documentElement.classList.contains("dark");
  const theme = createSignal(isDark());
  const observer = new MutationObserver(() => theme.set(isDark()));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  cleanups.push(() => observer.disconnect());

  // Route: sub-path and query below the page route.
  const route = createSignal<PalimPageRoute>(
    parsePageRoute(get(pathname), pageRoute),
    (a, b) => a.path === b.path && a.query.toString() === b.query.toString(),
  );
  cleanups.push(pathname.subscribe((appPath) => route.set(parsePageRoute(appPath, pageRoute))));

  const host: PalimHost = {
    extension: Object.freeze({ ...extension }),
    page: {
      id: pageId,
      get path() {
        return route.get().path;
      },
      get query() {
        return new URLSearchParams(route.get().query);
      },
      subscribe: route.subscribe,
    },
    fetch(path, init) {
      return authFetch(resolveExtensionPath(extension.name, path), init);
    },
    async json<T = unknown>(path: string, init: PalimJsonInit = {}): Promise<T> {
      const { body, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (!headers.has("accept")) headers.set("accept", "application/json");
      let payload: BodyInit | undefined;
      if (body !== undefined) {
        headers.set("content-type", "application/json");
        payload = JSON.stringify(body);
      }
      const res = await authFetch(resolveExtensionPath(extension.name, path), { ...rest, headers, body: payload });
      if (!res.ok) throw new Error(await responseError(res));
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    },
    onEvent(handler) {
      let handlers = uiEventHandlers.get(extension.name);
      if (!handlers) {
        handlers = new Set();
        uiEventHandlers.set(extension.name, handlers);
      }
      handlers.add(handler);
      ownHandlers.add(handler);
      return () => {
        handlers.delete(handler);
        ownHandlers.delete(handler);
      };
    },
    theme: {
      get dark() {
        return theme.get();
      },
      subscribe: theme.subscribe,
    },
    user: {
      get username() {
        return identity.user?.username ?? "";
      },
      get displayName() {
        return identity.user?.displayName || identity.user?.username || "";
      },
      can(action: AppAction, subject: AppSubject) {
        return identity.can(action, subject);
      },
    },
    navigate(path) {
      // Extension routes are not part of the typed route map.
      navigate(path as any);
    },
    notify(message, kind = "info") {
      options.notify(message, kind);
    },
    confirm(confirmOptions) {
      return options.confirm(confirmOptions);
    },
  };

  const dispose = () => {
    for (const cleanup of cleanups) cleanup();
    const handlers = uiEventHandlers.get(extension.name);
    for (const handler of ownHandlers) handlers?.delete(handler);
    ownHandlers.clear();
  };

  return { host, dispose };
}
