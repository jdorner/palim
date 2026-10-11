/**
 * Authenticated JSON client for the Palim API.
 *
 * Sends the stored bearer token, maps errors to {@link ApiError}, and signs
 * the user out on 401.
 *
 * @module
 */

import { apiUrl } from "./config";

const TOKEN_KEY = "palim.portal.token";

/** Called when the server rejects the token (set by the auth store). */
let onUnauthorized: (() => void) | null = null;

/**
 * Registers the handler for rejected tokens.
 *
 * @param fn - Called on any 401 response
 */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** Reads the stored token. */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Stores or clears the token. */
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the session lasts until reload.
  }
}

/** A failed API call. */
export class ApiError extends Error {
  /**
   * @param status - HTTP status (0 for network errors)
   * @param message - Server error message or a generic one
   * @param details - Validation details, when the server sent them
   */
  constructor(
    readonly status: number,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Performs an authenticated request and parses the JSON response.
 *
 * @param path - API path
 * @param init - Method and JSON body
 * @returns The parsed response body
 * @throws {ApiError} for non-2xx responses and network failures
 */
export async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: init.method ?? "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "Network error");
  }

  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; details?: { path: string; message: string }[] })
    | null;
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/auth/login") onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}
