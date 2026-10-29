/**
 * Auth/RBAC module barrel.
 *
 * Re-exports the public surface of the user-management subsystem: the ability
 * builder, the user store, the auth service, and the boot-time seeder.
 *
 * @module
 */

export type { AppAbility } from "./ability";
export { buildAbility, ownedSubject } from "./ability";
export type { AuthResolver, ResolvedPrincipal } from "./authService";
export { AuthService, hashToken, serializeAbility } from "./authService";
export {
  checkRoleAssignment,
  checkRoleDelete,
  checkRolePermissionsChange,
  checkRolePermissionsForPortalUsers,
  checkUserChange,
  checkUserDelete,
} from "./guards";
export { mintIdentityToken, resolveInitiatorToken, setIdentityMinter } from "./identityMinter";
export { seedAuth } from "./seed";
export { UserStore } from "./userStore";
