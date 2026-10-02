/**
 * Process-wide accessor for minting per-job identity tokens.
 *
 * Some job producers (notably the workflows DAG step worker) are constructed
 * deep inside extension code that does not receive the {@link AuthService}
 * through its dependency chain. Rather than thread the service through every
 * layer, boot installs a minter here once; consumers call {@link mintIdentityToken}
 * to obtain a short-lived internal token bound to a given user so their
 * background work authorizes as that user (confused-deputy fix).
 *
 * When no minter is installed (e.g. in isolated tests), minting returns null and
 * callers fall back to the ambient/system identity.
 *
 * @module
 */

/** Signature of an identity-token minter: user id -> bearer token (or null). */
export type IdentityMinter = (userId: string, ttlMs?: number) => string | null;

/** The installed minter, or null before boot wires one. */
let _minter: IdentityMinter | null = null;

/**
 * Installs the process-wide identity-token minter.
 *
 * @param minter - Function that mints a bearer token for a user id.
 */
export function setIdentityMinter(minter: IdentityMinter): void {
  _minter = minter;
}

/**
 * Mints a short-lived internal bearer token for a user, if a minter is installed.
 *
 * @param userId - The user id to bind the token to.
 * @param ttlMs - Optional token lifetime in ms.
 * @returns The bearer token, or null when no minter is installed or minting fails.
 */
export function mintIdentityToken(userId: string, ttlMs?: number): string | null {
  return _minter ? _minter(userId, ttlMs) : null;
}

/**
 * Resolves the identity a background job must run under.
 *
 * A job that records an initiating user must run as that user. When no token
 * can be minted for them (user disabled or deleted, or no minter wired), the
 * job is refused rather than silently escalated to the ambient/system identity.
 * Only jobs with no recorded initiator (genuine background work) run as system.
 *
 * @param initiatorUserId - The job's recorded initiating user id, if any.
 * @param mint - Minter used to obtain the user's token.
 * @returns The user's bearer token, or null when the job has no initiator.
 * @throws When an initiator is recorded but no token can be minted for them.
 */
export function resolveInitiatorToken(
  initiatorUserId: string | undefined,
  mint: ((userId: string) => string | null) | undefined,
): string | null {
  if (!initiatorUserId) return null;
  const token = mint ? mint(initiatorUserId) : null;
  if (!token) {
    throw new Error(`Initiating user ${initiatorUserId} is disabled, deleted, or cannot be authenticated`);
  }
  return token;
}
