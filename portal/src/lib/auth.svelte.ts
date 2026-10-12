/**
 * Portal session: the signed-in user, their ability, and login/logout.
 *
 * The token is stored separately from the operator UI's, so signing in to the
 * portal never signs anyone in to the operator UI on the same origin.
 *
 * @module
 */

import { type AuthenticatedUser, canPerform, type SerializedAbility } from "$shared/auth";
import { ApiError, getToken, request, setToken, setUnauthorizedHandler } from "./api";
import { i18n } from "./i18n.svelte";

/** Session state. */
type SessionState = "loading" | "anonymous" | "ready";

/** The response of `GET /api/auth/me` and `POST /api/auth/login`. */
interface Identity {
  user: AuthenticatedUser;
  ability: SerializedAbility;
}

/** Reactive session store. */
class Session {
  /** Whether the session is being restored, absent, or ready. */
  state = $state<SessionState>("loading");
  /** The signed-in user. */
  user = $state<AuthenticatedUser | null>(null);
  /** The user's serialized ability. */
  ability = $state<SerializedAbility | null>(null);

  constructor() {
    setUnauthorizedHandler(() => this.#clear());
  }

  /** Whether the user may see and answer human tasks. */
  get canUseTasks(): boolean {
    return this.ability !== null && canPerform(this.ability, "update", "HumanTask");
  }

  /** Whether the user manages tasks (sees all, cancels, reassigns). */
  get canManageTasks(): boolean {
    return this.ability !== null && canPerform(this.ability, "manage", "HumanTask");
  }

  /** Whether the user may start workflows from the portal. */
  get canStartWorkflows(): boolean {
    return this.ability !== null && canPerform(this.ability, "create", "PortalWorkflow");
  }

  /** Restores the session from a stored token. */
  async restore(): Promise<void> {
    if (!getToken()) {
      this.state = "anonymous";
      return;
    }
    try {
      this.#apply(await request<Identity>("/api/auth/me"));
    } catch {
      this.#clear();
    }
  }

  /**
   * Signs in.
   *
   * @param username - Login name
   * @param password - Password
   * @throws {ApiError} on invalid credentials (401) or lockout (429)
   */
  async login(username: string, password: string): Promise<void> {
    const result = await request<Identity & { token: string }>("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    setToken(result.token);
    this.#apply(result);
  }

  /** Signs out (revokes the token on the server, best-effort). */
  async logout(): Promise<void> {
    try {
      await request("/api/auth/logout", { method: "POST" });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
    this.#clear();
  }

  /**
   * Stores the account's language preference.
   *
   * @param locale - Locale code, or null to follow the browser
   */
  async setLocale(locale: string | null): Promise<void> {
    await request("/api/auth/me/locale", { method: "PUT", body: { locale } });
    if (this.user) this.user = { ...this.user, locale: locale ?? undefined };
    i18n.setPreferred(locale);
  }

  #apply(identity: Identity): void {
    this.user = identity.user;
    this.ability = identity.ability;
    this.state = "ready";
    i18n.setPreferred(identity.user.locale);
  }

  #clear(): void {
    setToken(null);
    this.user = null;
    this.ability = null;
    this.state = "anonymous";
  }
}

/** The portal session. */
export const session = new Session();
