/**
 * Frontend identity store: the authenticated user and their serialized ability.
 *
 * Populated after login (or on app load) by fetching `GET /api/auth/me`. UI
 * gating uses {@link IdentityStore.can}, a thin wrapper over the shared,
 * dependency-free {@link canPerform}. The backend remains the authoritative
 * enforcement point; this only controls what the UI offers.
 *
 * @module
 */

import {
  type AppAction,
  type AppSubject,
  type AuthenticatedUser,
  canPerform,
  type SerializedAbility,
} from "$shared/auth";
import { authFetch } from "./auth";

/** Reactive identity state backed by Svelte 5 runes. */
class IdentityStore {
  /** The authenticated user, or null when unknown/logged out. */
  user = $state<AuthenticatedUser | null>(null);
  /** The serialized ability, or null when unknown/logged out. */
  ability = $state<SerializedAbility | null>(null);

  /** Whether an authenticated identity is currently loaded. */
  get isAuthenticated(): boolean {
    return this.user !== null;
  }

  /** Whether the current user holds the admin (superuser) role. */
  get isAdmin(): boolean {
    return this.ability?.isAdmin ?? false;
  }

  /**
   * Fetches the current user and ability from the server.
   *
   * @returns True when an identity was loaded, false when unauthenticated.
   */
  async refresh(): Promise<boolean> {
    try {
      const res = await authFetch("/api/auth/me");
      if (!res.ok) {
        this.clear();
        return false;
      }
      const data = (await res.json()) as { user: AuthenticatedUser; ability: SerializedAbility };
      this.user = data.user;
      this.ability = data.ability;
      return true;
    } catch {
      this.clear();
      return false;
    }
  }

  /**
   * Sets the identity directly (e.g. from a login response), avoiding a refetch.
   *
   * @param user - The authenticated user.
   * @param ability - The serialized ability.
   */
  set(user: AuthenticatedUser, ability: SerializedAbility): void {
    this.user = user;
    this.ability = ability;
  }

  /** Clears the identity (on logout or auth failure). */
  clear(): void {
    this.user = null;
    this.ability = null;
  }

  /**
   * Checks whether the current user may perform an action on a subject.
   *
   * Returns false when no identity is loaded. For ownership-scoped subjects,
   * pass the resource's owner id.
   *
   * @param action - The action to test.
   * @param subject - The subject to test.
   * @param ownerUserId - For `Session`, the session owner id.
   * @returns True when permitted.
   */
  can(action: AppAction, subject: AppSubject, ownerUserId?: string | null): boolean {
    if (!this.ability) return false;
    return canPerform(this.ability, action, subject, ownerUserId);
  }
}

/** Singleton identity store shared across the app. */
export const identity = new IdentityStore();
