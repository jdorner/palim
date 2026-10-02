/**
 * Shared constants for the auth subsystem.
 *
 * @module
 */

/**
 * Username of the built-in non-login `system` account.
 *
 * This account has no usable password (empty hash, which never verifies), so it
 * can never authenticate via login. It exists solely so the system principal
 * can be minted an internal token for genuine background/boot calls with no
 * originating user.
 */
export const SYSTEM_USERNAME = "system";
