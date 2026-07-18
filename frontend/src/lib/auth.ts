/**
 * Frontend authentication helpers.
 * Manages token storage in sessionStorage and provides an auth-aware fetch wrapper.
 *
 * IMPORTANT: This module must NOT import from router.ts to avoid circular dependencies.
 * The connection manager disconnect callback is injected via `registerDisconnect()`
 * to avoid circular imports (connectionStore imports auth, auth cannot import connectionStore).
 */

import { navigate } from "../router";

const TOKEN_KEY = "auth_token";

/** Whether the server requires auth. Cached after first successful check. */
let authRequired: boolean | null = null;

/** Prevents multiple simultaneous redirects to login. */
let redirecting = false;

/** Injected disconnect callback from the connection manager. */
let disconnectFn: (() => void) | null = null;

/**
 * Registers the disconnect function from the connection manager.
 * Called once during app initialization to break the circular dependency.
 * @param fn - The disconnect function to call on logout.
 */
export function registerDisconnect(fn: () => void): void {
  disconnectFn = fn;
}

/** Retrieves the stored auth token from sessionStorage. */
export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

/** Stores the auth token in sessionStorage. */
export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

/** Clears the stored auth token from sessionStorage. */
function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/**
 * Checks whether the server requires authentication. Result is cached
 * after the first successful call so subsequent checks are synchronous.
 *
 * When the server is unreachable (network error or 5xx), returns false
 * to avoid redirecting to the login page. The connection error state is
 * handled separately by the WebSocket connection logic.
 */
export async function checkAuthRequired(): Promise<boolean> {
  if (authRequired !== null) return authRequired;
  try {
    const token = getToken() ?? "";
    const res = await fetch("/api/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    // Server error (5xx) - treat as unreachable, don't redirect to login
    if (res.status >= 500) {
      return false;
    }
    if (!res.ok) {
      authRequired = true;
      return true;
    }
    const data = await res.json();
    authRequired = !data.authDisabled;
    return authRequired;
  } catch {
    // Network error - server unreachable, don't redirect to login
    return false;
  }
}

/** Resets the cached auth state (e.g. after login). */
export function resetAuthCache(): void {
  authRequired = null;
}

/**
 * Closes the WebSocket, clears the token, and redirects to the login page.
 * Debounced to prevent multiple simultaneous redirects.
 */
export function forceLogout(): void {
  if (redirecting) return;
  redirecting = true;
  disconnectFn?.();
  clearToken();
  resetAuthCache();
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
