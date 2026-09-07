/**
 * The identity abstraction (design: "Identity resolution", R1.3, R1.7, R22.4).
 *
 * Feature code imports the resolved `CurrentUser` and helpers from here and
 * nowhere else — never cookies, tokens, or the database directly. This single
 * seam is what lets the authentication source be switched from the development
 * login to IDCS without touching the rest of the application.
 */
export type { CurrentUser, Role, UserIdentity } from './current-user.js';
export {
  buildCurrentUser,
  deriveRoles,
  hasRole,
  isMemberOfTeam,
  leadsTeam,
} from './current-user.js';
export type { AuthSource } from './auth-source.js';
export { DevSessionAuthSource, parsePrincipalId } from './auth-source.js';
export type { UserIdentityLoader } from './identity-loader.js';
export { DbUserIdentityLoader } from './identity-loader.js';
export type { Credential, CredentialLoader } from './credential-loader.js';
export { DbCredentialLoader } from './credential-loader.js';
export type { DirectoryUser, UserDirectoryLoader } from './user-directory.js';
export {
  DbUserDirectoryLoader,
  ROLE_PRIORITY,
  ROLE_LABELS,
  highestPrivilegeRole,
  formatDirectoryLabel,
} from './user-directory.js';
export { CurrentUserResolver, createCurrentUserResolver } from './resolver.js';
