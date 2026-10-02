/**
 * Auth/RBAC module barrel.
 *
 * Re-exports the public surface of the user-management subsystem: the ability
 * builder, the user store, the auth service, and the boot-time seeder.
 *
 * @module
 */

export type { AbilityPrincipal, AppAbility, PermissionSet } from "./ability";
export { abilityFromSerialized, buildAbility, ownedSubject } from "./ability";
export type {
  AuthResolver,
  AuthServiceOptions,
  LoginResult,
  PasswordCost,
  ResolvedPrincipal,
} from "./authService";
export { AuthService, DEFAULT_SESSION_TTL_MS, hashToken, serializeAbility } from "./authService";
export type { UserChange } from "./guards";
export {
  checkRoleAssignment,
  checkRoleDelete,
  checkRolePermissionsChange,
  checkUserChange,
  checkUserDelete,
} from "./guards";
export type { IdentityMinter } from "./identityMinter";
export { mintIdentityToken, resolveInitiatorToken, setIdentityMinter } from "./identityMinter";
export type { SeedAuthOptions, SeedResult } from "./seed";
export { seedAuth } from "./seed";
export type {
  CreateUserOptions,
  RoleRecord,
  SessionTokenRecord,
  UserRecord,
  UserWithSecret,
} from "./userStore";
export { UserStore } from "./userStore";
