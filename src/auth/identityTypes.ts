/**
 * Alias-free contract of `ctx.internal.identity`, re-exported via `@ext/types`.
 *
 * Lets an extension act on behalf of a configured operator account (for
 * example a "run as" setting), without access to the user store or the auth
 * service itself.
 *
 * @module
 */

/** The identity operations available to extensions via `ctx.internal.identity`. */
export interface IdentityApi {
  /**
   * Lists the usernames of the accounts an extension may act as, sorted:
   * enabled operator accounts without the `admin` or `system` role. Portal
   * accounts, disabled users, and the `system` account are left out.
   *
   * @returns The usernames, e.g. to populate a "run as" settings dropdown
   */
  listOperatorUsernames(): string[];
  /**
   * Mints a short-lived internal bearer token for an operator account, so
   * calls made with it are authorized as that user. Every minted token is
   * logged with the extension's name.
   *
   * @param username - The account's username
   * @param ttlMs - Token lifetime in ms (default 1 hour)
   * @returns The token, or null unless the account is listed by {@link IdentityApi.listOperatorUsernames}
   */
  mintToken(username: string, ttlMs?: number): string | null;
  /**
   * Registers a reference count that keeps user deletion from removing an
   * account the extension still acts as (like a webhook's owner). Deleting a
   * user is refused while the counter returns a non-zero value for them.
   *
   * Counters are kept per extension and kind, so they never replace the core
   * trigger counters or those of other extensions.
   *
   * @param kind - Singular, human-readable kind used in the refusal message (e.g. "MCP server run-as binding")
   * @param counter - Returns how many references the extension holds to the given username
   * @returns A function that removes the registration (call it in `shutdown()`)
   */
  registerOwnerCounter(kind: string, counter: (username: string) => number): () => void;
}
