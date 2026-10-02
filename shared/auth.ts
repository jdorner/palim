/**
 * Authentication and authorization types shared between backend and frontend.
 *
 * This module is the single source of truth for the permission vocabulary and
 * the built-in role definitions. It is intentionally a pure data + type module
 * with no backend-only (Node/Bun) imports, so it is import-safe from both the
 * backend runtime (`src/auth/`, `src/web/`) and the frontend build
 * (`frontend/`). The CASL ability builder (`src/auth/ability.ts`) consumes these
 * permission strings and role definitions so the backend enforcement and the
 * frontend UI gating cannot drift apart.
 *
 * @module
 */

/**
 * The complete catalog of permission strings, grouped by domain.
 *
 * A permission is an opaque `<domain>:<action>` string. Roles are mapped to a
 * set of these permissions; the ability builder translates a user's effective
 * permission set into CASL rules. Adding a permission here and referencing it
 * from a route guard is the canonical way to gate a new capability.
 *
 * Only writes and management are permission-gated: every authenticated user may
 * read everything except other users' chat sessions, so there are no `*:read`
 * permissions.
 */
export const PERMISSIONS = {
  /** Create chat sessions and send messages in, clear, or delete your own sessions. */
  CHAT_WRITE: "chat:write",
  /** Run workflows and cancel, signal, or delete workflow runs. */
  WORKFLOWS_WRITE: "workflows:write",
  /**
   * Create, edit, and delete workflow definitions. Definitions are shared and
   * unowned (runs triggered by other users' schedules/webhooks execute them with
   * those users' authority), so editing one is a privileged operation.
   */
  WORKFLOWS_MANAGE: "workflows:manage",
  /** Cancel, retry, and clean jobs. */
  JOBS_WRITE: "jobs:write",
  /**
   * Create, edit, and delete scheduler/filewatcher/webhook trigger registrations.
   * Editing a trigger makes the editor its owner, so it never runs modified
   * config with another user's authority.
   */
  TRIGGERS_WRITE: "triggers:write",
  /** Create, edit, and delete secrets. */
  SECRETS_WRITE: "secrets:write",
  /** Create, edit, and delete global variables. */
  VARIABLES_WRITE: "variables:write",
  /** Change the selected model. */
  MODELS_WRITE: "models:write",
  /** Enable/disable extensions and edit their settings. */
  EXTENSIONS_WRITE: "extensions:write",
  /** Manage users, roles, and role permissions. */
  USERS_MANAGE: "users:manage",
} as const;

/** A single permission string drawn from the {@link PERMISSIONS} catalog. */
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** The full ordered list of every known permission string. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/** An immutable set of permissions granted to a principal. */
export type PermissionSet = readonly Permission[];

/** The canonical name of the built-in administrator role. */
export const ROLE_ADMIN = "admin";
/** The canonical name of the built-in standard-user role. */
export const ROLE_USER = "user";
/**
 * The canonical name of the built-in system role.
 *
 * The `system` principal is NOT a login account. It is used only for genuine
 * system-initiated background calls that have no originating user (e.g.
 * boot-time work). It is deliberately narrow and MUST never carry
 * {@link PERMISSIONS.USERS_MANAGE} or {@link PERMISSIONS.SECRETS_WRITE}.
 */
export const ROLE_SYSTEM = "system";

/** Definition of a built-in role: its name, description, and granted permissions. */
export interface RoleDefinition {
  /** The unique role name. */
  name: string;
  /** Human-readable description of the role's purpose. */
  description: string;
  /**
   * The permissions granted by this role. When `null`, the role is a
   * superuser that implicitly holds every permission (see {@link ROLE_ADMIN}).
   */
  permissions: PermissionSet | null;
}

/**
 * The standard-user permission set: chat, run workflows, manage jobs and
 * triggers. Deliberately excludes editing workflow definitions and all write
 * access to secrets, variables, extensions, models, and any user management.
 */
const USER_PERMISSIONS: PermissionSet = [
  PERMISSIONS.CHAT_WRITE,
  PERMISSIONS.WORKFLOWS_WRITE,
  PERMISSIONS.JOBS_WRITE,
  PERMISSIONS.TRIGGERS_WRITE,
];

/**
 * The narrow system permission set for background/boot calls with no user.
 *
 * Intentionally minimal: enough to enqueue chat work (reads are implicit), but
 * no user management and no secret writes. Any capability granted here is
 * inheritable by background flows, so it must stay least-privilege.
 */
const SYSTEM_PERMISSIONS: PermissionSet = [PERMISSIONS.CHAT_WRITE];

/**
 * The built-in roles seeded on first boot, keyed by role name.
 *
 * `admin` is a superuser (`permissions: null` -> implicit `manage all`);
 * `user` is the standard scoped role; `system` is the narrow non-login
 * background principal.
 */
export const BUILT_IN_ROLES: Readonly<Record<string, RoleDefinition>> = {
  [ROLE_ADMIN]: {
    name: ROLE_ADMIN,
    description: "Full administrative access to all resources and user management.",
    permissions: null,
  },
  [ROLE_USER]: {
    name: ROLE_USER,
    description: "Standard user: reads everything; chats, runs workflows, and manages jobs and triggers.",
    permissions: USER_PERMISSIONS,
  },
  [ROLE_SYSTEM]: {
    name: ROLE_SYSTEM,
    description: "Narrow background principal for system-initiated calls with no user.",
    permissions: SYSTEM_PERMISSIONS,
  },
} as const;

/**
 * The set of resource "subject" types recognized by the CASL ability layer.
 *
 * `Session` is the only ownership-scoped subject: it carries a `userId` field
 * that ownership conditions match against. All other subjects are checked by
 * permission alone.
 */
export type AppSubject =
  | "Session"
  | "Workflow"
  | "WorkflowRun"
  | "Job"
  | "Trigger"
  | "Secret"
  | "Variable"
  | "Model"
  | "Extension"
  | "User"
  | "all";

/** The CASL actions recognized by the ability layer. */
export type AppAction = "read" | "create" | "update" | "delete" | "manage";

/**
 * The serialized ability payload sent to the frontend by `GET /api/auth/me`.
 *
 * The frontend rebuilds an identical CASL ability from this payload using the
 * shared {@link import("../src/auth/ability").buildAbility} builder, so UI
 * gating matches backend enforcement exactly.
 */
export interface SerializedAbility {
  /** The authenticated user's opaque id, used by ownership conditions. */
  userId: string;
  /** Whether the user holds the superuser (`admin`) role. */
  isAdmin: boolean;
  /** The user's effective permission set (empty for admins, who use `manage all`). */
  permissions: Permission[];
}

/** The authenticated user identity returned by `GET /api/auth/me`. */
export interface AuthenticatedUser {
  /** The user's opaque id. */
  id: string;
  /** The unique login username. */
  username: string;
  /** Optional human-readable display name. */
  displayName?: string;
  /** The names of roles assigned to the user. */
  roles: string[];
}

/**
 * Subjects every authenticated principal may read without any permission.
 * `Session` is readable only by its owner; `User` requires `users:manage`.
 */
export const READABLE_SUBJECTS: readonly AppSubject[] = [
  "Workflow",
  "WorkflowRun",
  "Job",
  "Trigger",
  "Secret",
  "Variable",
  "Model",
  "Extension",
];

/**
 * Maps each permission to the (action, subject) grants it confers.
 *
 * This mirrors the backend CASL ability builder so the frontend can gate UI
 * without depending on `@casl/ability`. `Session` grants are ownership-scoped;
 * callers that need ownership semantics should use {@link canPerform} with an
 * explicit `ownerUserId`.
 */
const PERMISSION_GRANTS: Readonly<Record<Permission, ReadonlyArray<[AppAction, AppSubject]>>> = {
  [PERMISSIONS.CHAT_WRITE]: [
    ["create", "Session"],
    ["update", "Session"],
    ["delete", "Session"],
  ],
  [PERMISSIONS.WORKFLOWS_WRITE]: [
    ["create", "WorkflowRun"],
    ["update", "WorkflowRun"],
    ["delete", "WorkflowRun"],
  ],
  [PERMISSIONS.WORKFLOWS_MANAGE]: [["manage", "Workflow"]],
  [PERMISSIONS.JOBS_WRITE]: [
    ["update", "Job"],
    ["delete", "Job"],
  ],
  [PERMISSIONS.TRIGGERS_WRITE]: [
    ["create", "Trigger"],
    ["update", "Trigger"],
    ["delete", "Trigger"],
  ],
  [PERMISSIONS.SECRETS_WRITE]: [["manage", "Secret"]],
  [PERMISSIONS.VARIABLES_WRITE]: [["manage", "Variable"]],
  [PERMISSIONS.MODELS_WRITE]: [["update", "Model"]],
  [PERMISSIONS.EXTENSIONS_WRITE]: [["manage", "Extension"]],
  [PERMISSIONS.USERS_MANAGE]: [["manage", "User"]],
};

/**
 * Whether a `manage`-level grant on a subject implies a specific action.
 *
 * @param action - The requested action.
 * @returns True for the standard CRUD actions that `manage` subsumes.
 */
function manageImplies(action: AppAction): boolean {
  return action === "read" || action === "create" || action === "update" || action === "delete" || action === "manage";
}

/**
 * Lightweight, dependency-free authorization check from a {@link SerializedAbility}.
 *
 * Mirrors the backend CASL ability for the purpose of UI gating. Admins can do
 * anything. Non-admins may read every {@link READABLE_SUBJECTS} subject and
 * their own sessions; otherwise a permission's grants are consulted and a
 * `manage` grant subsumes the CRUD actions. For `Session`, pass `ownerUserId`:
 * the check additionally requires the session to be owned by the ability's user
 * (admins bypass this).
 *
 * This is intentionally advisory (UI convenience). The backend remains the
 * authoritative enforcement point.
 *
 * @param ability - The serialized ability payload from `GET /api/auth/me`.
 * @param action - The action to test.
 * @param subject - The subject to test.
 * @param ownerUserId - For `Session`, the session's owner id.
 * @returns True when the action is permitted.
 */
export function canPerform(
  ability: SerializedAbility,
  action: AppAction,
  subject: AppSubject,
  ownerUserId?: string | null,
): boolean {
  if (ability.isAdmin) return true;

  if (action === "read" && READABLE_SUBJECTS.includes(subject)) return true;

  // Sessions are owner-scoped: everyone may read their own, and non-create
  // actions on a known session require ownership.
  if (subject === "Session" && action !== "create") {
    if (ownerUserId !== undefined && ownerUserId !== ability.userId) return false;
    if (action === "read") return true;
  }

  for (const permission of ability.permissions) {
    const grants = PERMISSION_GRANTS[permission];
    if (!grants) continue;
    for (const [grantAction, grantSubject] of grants) {
      if (grantSubject !== subject) continue;
      if (grantAction === action) return true;
      if (grantAction === "manage" && manageImplies(action)) return true;
    }
  }
  return false;
}
