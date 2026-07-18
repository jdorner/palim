/**
 * TypeBox schemas for webhook validation - used by both the REST API
 * and the agent tool.
 */

import { Type } from "@sinclair/typebox";

/** Schema for the webhook auth type field. */
export const WebhookAuthTypeSchema = Type.Union([
  Type.Literal("hmac-sha256"),
  Type.Literal("bearer"),
  Type.Literal("none"),
]);

/** Schema for creating a webhook via REST or the agent tool. */
export const CreateWebhookPayload = Type.Object(
  {
    slug: Type.String({
      minLength: 1,
      pattern: "^[a-z0-9][a-z0-9-]*$",
      description: "URL-safe slug for the webhook endpoint",
    }),
    name: Type.String({ minLength: 1, description: "Human-readable label" }),
    authType: WebhookAuthTypeSchema,
    secret: Type.Optional(
      Type.String({
        description: "HMAC secret or bearer token (min 8 chars). Not required when authType is 'none'.",
      }),
    ),
    headerName: Type.Optional(
      Type.String({
        description:
          'HTTP header carrying the signature/token (default: "X-Hub-Signature-256" for HMAC, "Authorization" for bearer)',
      }),
    ),
    enabled: Type.Optional(Type.Boolean({ description: "Whether the webhook is active (default: true)" })),
  },
  { additionalProperties: false },
);

/** Schema for updating a webhook via REST. All fields are optional - only provided fields are updated. */
export const UpdateWebhookPayload = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, description: "Human-readable label" })),
    authType: Type.Optional(WebhookAuthTypeSchema),
    secret: Type.Optional(
      Type.String({
        description: "HMAC secret or bearer token (min 8 chars). Not required when authType is 'none'.",
      }),
    ),
    headerName: Type.Optional(Type.String({ description: "HTTP header carrying the signature/token" })),
    enabled: Type.Optional(Type.Boolean({ description: "Whether the webhook is active" })),
  },
  { additionalProperties: false },
);
