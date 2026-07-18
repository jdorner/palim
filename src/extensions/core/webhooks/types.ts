/**
 * Shared types for the webhooks extension.
 */

/** Supported authentication strategies for incoming webhooks. */
export type WebhookAuthType = "hmac-sha256" | "bearer" | "none";

/** A persisted webhook registration. */
export interface WebhookRegistration {
  /** URL-safe slug - the endpoint becomes POST /ext/webhooks/receive/:slug */
  slug: string;
  /** Human-readable label. */
  name: string;
  /** Authentication strategy. */
  authType: WebhookAuthType;
  /** HMAC secret or bearer token (depending on authType). */
  secret: string;
  /** HTTP header carrying the signature/token (e.g. "X-Hub-Signature-256"). */
  headerName: string;
  /** Whether this webhook is active. */
  enabled: boolean;
  /** Creation timestamp (ms). */
  createdAt: number;
}
