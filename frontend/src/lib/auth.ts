/**
 * Frontend authentication helpers.
 * Manages token storage in localStorage (shared by all tabs of the origin) and provides
 * an auth-aware fetch wrapper.
 *
 * IMPORTANT: This module must NOT import connectionStore or the identity store, which
 * both import auth. Their logout hooks are injected via `registerDisconnect()` and
 * `registerClearIdentity()` instead.
 */

import { navigate } from "../router";

const TOKEN_KEY = "auth_token";

/** Prevents multiple simultaneous redirects to login. */
let redirecting = false;

/** Injected disconnect callback from the connection manager. */
let disconnectFn: (() => void) | null = null;

/** Injected callback to clear identity state on logout (set by app init). */
let clearIdentityFn: (() => void) | null = null;

/**
 * Registers a callback that clears identity state on logout.
 *
 * Injected during app initialization to avoid a circular import between the
 * identity store (which imports authFetch) and this module.
 *
 * @param fn - The identity-clearing function.
 */
export function registerClearIdentity(fn: () => void): void {
  clearIdentityFn = fn;
}

/**
 * Registers the disconnect function from the connection manager.
 * Called once during app initialization to break the circular dependency.
 * @param fn - The disconnect function to call on logout.
 */
export function registerDisconnect(fn: () => void): void {
  disconnectFn = fn;
}

/** Retrieves the stored auth token from localStorage. */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Stores the auth token in localStorage. */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** Clears the stored auth token from localStorage. */
function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Keep other tabs in sync: the `storage` event fires only in tabs other than the
// one that made the change. A removed token means another tab logged out; a
// different token means another tab signed in (possibly as another user), so
// reload to pick up the new identity and WebSocket connection.
window.addEventListener("storage", (e) => {
  if (e.key !== TOKEN_KEY && e.key !== null) return;
  const token = getToken();
  if (token === null) {
    forceLogout();
  } else if (e.key === TOKEN_KEY && e.newValue !== e.oldValue) {
    // Leave the login page behind, otherwise the reload lands right back on it.
    if (location.hash.startsWith("#/login")) location.hash = "#/";
    location.reload();
  }
});

/**
 * Closes the WebSocket, clears the token, and redirects to the login page.
 * Debounced to prevent multiple simultaneous redirects.
 */
export function forceLogout(): void {
  if (redirecting) return;
  redirecting = true;
  disconnectFn?.();
  clearIdentityFn?.();
  clearToken();
  navigate("/login");
  setTimeout(() => {
    redirecting = false;
  }, 100);
}

/**
 * Auth-aware fetch wrapper. Injects the Authorization header when a token
 * is stored, and handles 401 responses by forcing logout.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(input, { ...init, headers });

  if (res.status === 401) {
    forceLogout();
  }

  return res;
}
