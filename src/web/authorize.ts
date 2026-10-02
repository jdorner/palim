/**
 * Central authorization table for HTTP routes.
 *
 * Maps request method + path patterns to a required CASL ability check. This
 * keeps coarse, feature-level authorization (who may hit which endpoint) in one
 * auditable place, layered on top of authentication. Fine-grained ownership
 * checks (does this user own this specific session?) live in the individual
 * route handlers using the resolved principal's ability.
 *
 * Reads are open: every authenticated principal may read everything, so `GET`
 * and `HEAD` requests are allowed without a rule, except for the user/role
 * administration surface (and other users' chat sessions, which the session
 * handlers guard by ownership). Rules exist to deny writes and management to
 * principals lacking the relevant permission.
 *
 * An `/api/*` write that matches no rule is allowed through (authentication is
 * still required by the auth check). Extension writes (`/ext/*`) fail closed
 * instead: extensions can register arbitrary handlers (some of which spawn host
 * processes), so an `/ext/*` write without an explicit rule requires
 * `manage Extension` (admin by default). New extension write routes meant for
 * non-admins must be added to the table.
 *
 * @module
 */

import type { AppAction, AppSubject } from "@shared/auth";
import type { AppAbility } from "@src/auth";

/** HTTP methods an authorization rule can match. */
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A single authorization rule: match method+path, require an ability. */
interface AuthorizationRule {
  /** HTTP methods this rule applies to. */
  methods: Method[];
  /** Regex tested against the request pathname. */
  pattern: RegExp;
  /** The CASL action required. */
  action: AppAction;
  /** The CASL subject required. */
  subject: AppSubject;
}

/** Mutating HTTP methods. */
const WRITE_METHODS: Method[] = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * The authorization rules, evaluated in order. The first matching rule decides
 * the required ability. Reads matching no rule are allowed; writes matching no
 * rule are allowed under `/api/*` (subject only to authentication and the
 * session handlers' ownership checks) and fall through to
 * {@link EXT_FALLBACK_RULE} under `/ext/*`.
 */
const RULES: readonly AuthorizationRule[] = [
  // User/role administration - admin only.
  {
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    pattern: /^\/api\/users(\/|$)/,
    action: "manage",
    subject: "User",
  },
  {
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    pattern: /^\/api\/roles(\/|$)/,
    action: "manage",
    subject: "User",
  },
  // Global secrets.
  { methods: ["PUT", "PATCH", "DELETE"], pattern: /^\/api\/secrets(\/|$)/, action: "manage", subject: "Secret" },
  // Extension secrets.
  {
    methods: ["PUT", "DELETE"],
    pattern: /^\/api\/extensions\/[^/]+\/secrets(\/|$)/,
    action: "manage",
    subject: "Secret",
  },
  // Global variables.
  { methods: ["PUT", "PATCH", "DELETE"], pattern: /^\/api\/variables(\/|$)/, action: "manage", subject: "Variable" },
  // Model selection.
  { methods: ["PUT", "POST"], pattern: /^\/api\/models(\/|$)/, action: "update", subject: "Model" },
  // Job control.
  { methods: ["POST"], pattern: /^\/api\/jobs\/[^/]+\/(cancel|retry)$/, action: "update", subject: "Job" },
  { methods: ["POST"], pattern: /^\/api\/queues\/clean$/, action: "delete", subject: "Job" },
  // Extension enable/disable + settings mutations.
  {
    methods: ["PUT", "POST", "PATCH", "DELETE"],
    pattern: /^\/api\/extensions(\/|$)/,
    action: "manage",
    subject: "Extension",
  },

  // --- Extension routes (/ext/*). Anything unlisted hits EXT_FALLBACK_RULE. ---

  // Workflows: running needs workflows:write; definitions are shared, so
  // editing them needs workflows:manage.
  { methods: ["POST"], pattern: /^\/ext\/workflows\/run\/[^/]+$/, action: "create", subject: "WorkflowRun" },
  {
    methods: ["POST"],
    pattern: /^\/ext\/workflows\/runs\/[^/]+\/signal\/[^/]+$/,
    action: "update",
    subject: "WorkflowRun",
  },
  { methods: ["DELETE"], pattern: /^\/ext\/workflows\/runs\/[^/]+$/, action: "delete", subject: "WorkflowRun" },
  { methods: ["POST"], pattern: /^\/ext\/workflows\/meta\/validate$/, action: "read", subject: "Workflow" },
  { methods: WRITE_METHODS, pattern: /^\/ext\/workflows(\/|$)/, action: "manage", subject: "Workflow" },

  // Triggers: any principal with triggers:write may change any trigger; the
  // handlers re-bind an edited trigger to the editor.
  // (Webhook receive routes are public and never reach this table.)
  { methods: ["POST"], pattern: /^\/ext\/scheduler\/schedules\/[^/]+\/trigger$/, action: "update", subject: "Trigger" },
  {
    methods: ["POST"],
    pattern: /^\/ext\/(scheduler|webhooks|filewatcher)(\/|$)/,
    action: "create",
    subject: "Trigger",
  },
  {
    methods: ["PUT", "PATCH"],
    pattern: /^\/ext\/(scheduler|webhooks|filewatcher)(\/|$)/,
    action: "update",
    subject: "Trigger",
  },
  {
    methods: ["DELETE"],
    pattern: /^\/ext\/(scheduler|webhooks|filewatcher)(\/|$)/,
    action: "delete",
    subject: "Trigger",
  },

  // MCP: adding/editing servers spawns host processes and calling a tool
  // executes it directly, so every mutation is admin-level.
  { methods: WRITE_METHODS, pattern: /^\/ext\/mcp(\/|$)/, action: "manage", subject: "Extension" },

  // Wiki: search/read only.
  { methods: ["GET", "POST"], pattern: /^\/ext\/wiki\/(search|docs|stats)$/, action: "read", subject: "Extension" },

  // Converter: enqueues an agent job, equivalent to sending a chat prompt.
  { methods: ["POST"], pattern: /^\/ext\/converter\/convert$/, action: "create", subject: "Session" },
];

/**
 * Applied to any `/ext/*` write no rule in {@link RULES} matched, so an
 * extension route is admin-only until it is explicitly classified.
 */
const EXT_FALLBACK_RULE: Pick<AuthorizationRule, "action" | "subject"> = { action: "manage", subject: "Extension" };

/**
 * The result of an authorization decision.
 */
export interface AuthorizationDecision {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** The matched rule's required action, when a rule matched (for diagnostics). */
  requiredAction?: AppAction;
  /** The matched rule's required subject, when a rule matched (for diagnostics). */
  requiredSubject?: AppSubject;
}

/**
 * Decides whether a principal's ability permits a request to the given
 * method+path, using the central rule table.
 *
 * @param method - The HTTP method (case-insensitive).
 * @param pathname - The request pathname.
 * @param ability - The authenticated principal's CASL ability.
 * @returns An {@link AuthorizationDecision}. Reads and `/api/*` writes matching
 *   no rule are allowed; `/ext/*` writes matching no rule require {@link EXT_FALLBACK_RULE}.
 */
export function authorizeRequest(method: string, pathname: string, ability: AppAbility): AuthorizationDecision {
  // HEAD is served by GET handlers, so it is authorized like GET.
  const normalized = method.toUpperCase();
  const upper = (normalized === "HEAD" ? "GET" : normalized) as Method;
  for (const rule of RULES) {
    if (!rule.methods.includes(upper)) continue;
    if (!rule.pattern.test(pathname)) continue;
    const allowed = ability.can(rule.action, rule.subject);
    return { allowed, requiredAction: rule.action, requiredSubject: rule.subject };
  }
  if (upper === "GET") return { allowed: true };
  if (pathname.startsWith("/ext/")) {
    const { action, subject } = EXT_FALLBACK_RULE;
    return { allowed: ability.can(action, subject), requiredAction: action, requiredSubject: subject };
  }
  return { allowed: true };
}
