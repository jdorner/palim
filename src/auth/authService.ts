/**
 * Authentication service: password verification, opaque session-token issuance,
 * and token resolution to an authenticated principal with a CASL ability.
 *
 * Login issues a random opaque token; only its SHA-256 hash is persisted, so a
 * database leak never exposes usable tokens. Resolution looks the token up by
 * hash, rejects expired/unknown tokens and disabled users, refreshes the
 * last-used timestamp, and builds the caller's {@link AppAbility} from their
 * effective permissions (admins become superusers).
 *
 * The {@link AuthResolver} interface abstracts "token -> principal" so an
 * alternative resolver (e.g. SSO/OIDC) can be added later without changing
 * call sites in the web server.
 *
 * @module
 */

import { createHash, randomBytes } from "node:crypto";
import { type AuthenticatedUser, type Permission, ROLE_ADMIN, type SerializedAbility } from "@shared/auth";
import { type AppAbility, buildAbility } from "./ability";
import type { UserStore } from "./userStore";

/** Default lifetime of an issued session token, in milliseconds (7 days). */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Number of random bytes in an opaque session token. */
const TOKEN_BYTES = 32;

/**
 * A cached internal token is reused only while at least this fraction of the
 * requested lifetime remains, so callers always get a token that stays valid
 * for a meaningful share of the TTL they asked for.
 */
const INTERNAL_TOKEN_REUSE_FRACTION = 0.5;

/** A fully resolved, authenticated principal. */
export interface ResolvedPrincipal {
  /** The authenticated user (id, username, display name, role names). */
  user: AuthenticatedUser;
  /** Whether the user holds the built-in `admin` (superuser) role. */
  isAdmin: boolean;
  /** The user's effective permission set (empty for admins, who use `manage all`). */
  permissions: Permission[];
  /** The CASL ability enforcing this principal's authorization. */
  ability: AppAbility;
}

/**
 * Contract for resolving a bearer token to an authenticated principal.
 *
 * Implemented by {@link AuthService} for local accounts; a future SSO resolver
 * would implement the same interface so the web server's auth check stays
 * provider-agnostic.
 */
export interface AuthResolver {
  /**
   * Resolve a bearer token to a principal.
   *
   * @param token - The opaque bearer token.
   * @returns The resolved principal, or null when the token is invalid/expired.
   */
  resolveToken(token: string): ResolvedPrincipal | null;
}

/** Result of a successful login. */
export interface LoginResult {
  /** The opaque bearer token to present on subsequent requests. */
  token: string;
  /** Epoch timestamp (ms) when the token expires. */
  expiresAt: number;
  /** The resolved principal for the newly authenticated user. */
  principal: ResolvedPrincipal;
}

/**
 * argon2id cost parameters.
 *
 * Production uses `Bun.password` library defaults (memory-hard, deliberately
 * expensive). Tests may pass reduced costs so suites stay fast without
 * weakening production hashing.
 */
export interface PasswordCost {
  /** Memory cost in KiB. */
  memoryCost: number;
  /** Time cost (iterations). */
  timeCost: number;
}

/** Options controlling {@link AuthService} behavior. */
export interface AuthServiceOptions {
  /** Session token lifetime in ms; defaults to {@link DEFAULT_SESSION_TTL_MS}. */
  sessionTtlMs?: number;
  /**
   * Optional argon2id cost override. When omitted, `Bun.password` library
   * defaults are used (recommended for production). Tests may lower this.
   */
  passwordCost?: PasswordCost;
}

/**
 * Hashes an opaque token for storage/lookup using SHA-256.
 *
 * Tokens are high-entropy random values, so a fast cryptographic hash is
 * appropriate (unlike passwords, which use argon2id). Hashing avoids storing
 * usable tokens at rest.
 *
 * @param token - The opaque token.
 * @returns The lowercase hex SHA-256 digest.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Local-account authentication service.
 *
 * Wraps a {@link UserStore} with password hashing/verification and opaque
 * session-token management. Implements {@link AuthResolver}.
 */
export class AuthService implements AuthResolver {
  private readonly store: UserStore;
  private readonly sessionTtlMs: number;
  private readonly passwordCost?: PasswordCost;
  /** Reusable internal tokens, keyed by `<userId>:<ttlMs>`. */
  private readonly internalTokens = new Map<string, { token: string; expiresAt: number }>();
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Create an AuthService.
   *
   * @param store - The user store backing accounts, roles, and sessions.
   * @param opts - Optional service configuration (session TTL, password cost).
   */
  constructor(store: UserStore, opts: AuthServiceOptions = {}) {
    this.store = store;
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.passwordCost = opts.passwordCost;
  }

  /**
   * Hash a plaintext password with argon2id using this service's cost settings.
   *
   * @param password - The plaintext password.
   * @returns The argon2id hash string.
   * @throws When hashing fails.
   */
  async hashPassword(password: string): Promise<string> {
    if (this.passwordCost) {
      return Bun.password.hash(password, {
        algorithm: "argon2id",
        memoryCost: this.passwordCost.memoryCost,
        timeCost: this.passwordCost.timeCost,
      });
    }
    return Bun.password.hash(password, { algorithm: "argon2id" });
  }

  /**
   * Verify a plaintext password against a stored hash.
   *
   * argon2id hashes are self-describing (parameters are encoded in the hash), so
   * verification does not need the original cost settings.
   *
   * @param password - The plaintext password to check.
   * @param hash - The stored argon2id hash.
   * @returns True when the password matches.
   */
  static async verifyPassword(password: string, hash: string): Promise<boolean> {
    if (!hash) return false;
    try {
      return await Bun.password.verify(password, hash);
    } catch {
      // Malformed hash or unsupported algorithm - treat as a failed verification.
      return false;
    }
  }

  /**
   * Authenticate a username/password pair and issue an opaque session token.
   *
   * @param username - The login username.
   * @param password - The plaintext password.
   * @returns A {@link LoginResult} on success, or null on bad credentials or a disabled account.
   * @throws When the underlying store write fails.
   */
  async login(username: string, password: string): Promise<LoginResult | null> {
    const user = this.store.getUserByUsername(username);
    if (!user || user.disabled) return null;

    const ok = await AuthService.verifyPassword(password, user.passwordHash);
    if (!ok) return null;

    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const expiresAt = Date.now() + this.sessionTtlMs;
    this.store.insertSession({ userId: user.id, tokenHash: hashToken(token), expiresAt });

    const principal = this.buildPrincipal(user.id, user.username, user.displayName, user.locale);
    if (!principal) return null;
    return { token, expiresAt, principal };
  }

  /**
   * Resolve a bearer token to an authenticated principal.
   *
   * Rejects unknown or expired tokens and disabled users. On success, refreshes
   * the session's last-used timestamp.
   *
   * @param token - The opaque bearer token.
   * @returns The resolved principal, or null when invalid/expired.
   */
  resolveToken(token: string): ResolvedPrincipal | null {
    if (!token) return null;
    const session = this.store.findSessionByTokenHash(hashToken(token));
    if (!session) return null;

    const now = Date.now();
    if (session.expiresAt < now) {
      // Opportunistically clean up the expired row.
      this.store.deleteSessionByTokenHash(session.tokenHash);
      return null;
    }

    const user = this.store.getUserById(session.userId);
    if (!user || user.disabled) return null;

    this.store.touchSession(session.id, now);
    return this.buildPrincipal(user.id, user.username, user.displayName, user.locale);
  }

  /**
   * Revoke a session token (logout).
   *
   * @param token - The opaque bearer token to revoke.
   * @returns True when a session was found and removed.
   * @throws When the store write fails.
   */
  logout(token: string): boolean {
    if (!token) return false;
    return this.store.deleteSessionByTokenHash(hashToken(token));
  }

  /**
   * Mint a non-login internal token bound to an existing user (principal).
   *
   * Used to give in-process work (agent jobs, workflow steps) a token that
   * resolves to a specific initiating user, so internal calls authorize as that
   * user rather than a shared privileged identity. The token is a normal
   * DB-backed session token and is revocable/expirable like any other.
   *
   * Tokens are cached per user and TTL and reused while at least half of the
   * requested lifetime remains (and the backing row still exists), so busy
   * queues do not insert a new session row for every job or workflow step.
   *
   * @param userId - The user id to bind the token to.
   * @param ttlMs - Optional lifetime override in ms; defaults to the service TTL.
   * @returns The opaque token and its expiry, or null when the user is missing/disabled.
   * @throws When the store write fails.
   */
  mintInternalToken(userId: string, ttlMs?: number): { token: string; expiresAt: number } | null {
    const user = this.store.getUserById(userId);
    if (!user || user.disabled) return null;

    const ttl = ttlMs ?? this.sessionTtlMs;
    const now = Date.now();
    const cacheKey = `${userId}:${ttl}`;
    const cached = this.internalTokens.get(cacheKey);
    if (
      cached &&
      cached.expiresAt - now >= ttl * INTERNAL_TOKEN_REUSE_FRACTION &&
      // The row may have been revoked (logout-all, password change, user disable).
      this.store.findSessionByTokenHash(hashToken(cached.token))
    ) {
      return { ...cached };
    }

    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const expiresAt = now + ttl;
    this.store.insertSession({ userId, tokenHash: hashToken(token), expiresAt });
    this.internalTokens.set(cacheKey, { token, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Remove expired session tokens (periodic maintenance).
   *
   * @returns The number of expired rows removed.
   * @throws When the store write fails.
   */
  purgeExpiredSessions(): number {
    const now = Date.now();
    for (const [key, entry] of this.internalTokens) {
      if (entry.expiresAt < now) this.internalTokens.delete(key);
    }
    return this.store.deleteExpiredSessions(now);
  }

  /**
   * Start a periodic timer that calls {@link purgeExpiredSessions}.
   *
   * Replaces any previously started timer and runs one purge immediately. The
   * timer is unref'd so it never keeps the process alive on its own. Purge
   * failures are passed to `onError` rather than thrown.
   *
   * @param intervalMs - Interval between purge runs, in ms.
   * @param onError - Optional callback for purge failures.
   * @param onPurged - Optional callback receiving the number of rows removed per run.
   */
  startPurgeTimer(intervalMs: number, onError?: (err: unknown) => void, onPurged?: (count: number) => void): void {
    this.stopPurgeTimer();
    const run = () => {
      try {
        const purged = this.purgeExpiredSessions();
        onPurged?.(purged);
      } catch (err) {
        onError?.(err);
      }
    };
    this.purgeTimer = setInterval(run, intervalMs);
    this.purgeTimer.unref();
    run();
  }

  /**
   * Stop the periodic expired-session purge timer, if running.
   */
  stopPurgeTimer(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
  }

  /**
   * Build a {@link ResolvedPrincipal} for a user by loading their roles and
   * effective permissions and constructing the CASL ability.
   *
   * @param userId - The user id.
   * @param username - The user's username.
   * @param displayName - The user's optional display name.
   * @param locale - The user's optional preferred UI locale.
   * @returns The resolved principal, or null when role loading fails unexpectedly.
   */
  private buildPrincipal(userId: string, username: string, displayName?: string, locale?: string): ResolvedPrincipal {
    const roleNames = this.store.getUserRoleNames(userId);
    const isAdmin = roleNames.includes(ROLE_ADMIN);
    const permissions = isAdmin ? [] : this.store.getEffectivePermissions(userId);
    const ability = buildAbility({ userId, isAdmin, permissions });
    const user: AuthenticatedUser = { id: userId, username, displayName, locale, roles: roleNames };
    return { user, isAdmin, permissions, ability };
  }
}

/**
 * Serializes a resolved principal into the payload sent to the frontend.
 *
 * @param principal - The resolved principal.
 * @returns The serialized ability payload for `GET /api/auth/me`.
 */
export function serializeAbility(principal: ResolvedPrincipal): SerializedAbility {
  return {
    userId: principal.user.id,
    isAdmin: principal.isAdmin,
    permissions: principal.permissions,
  };
}
