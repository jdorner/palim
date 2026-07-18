/**
 * TypeBox schemas for file watcher validation - used by both the REST API
 * and runtime validation.
 */

import { Type } from "@sinclair/typebox";

/** Schema for valid file watcher event types. */
const FileWatcherEventTypeSchema = Type.Union([Type.Literal("new"), Type.Literal("change"), Type.Literal("delete")], {
  description: "File system event type to watch for",
});

/** Schema for creating a file watcher via REST. */
export const CreateFileWatcherPayload = Type.Object(
  {
    slug: Type.String({
      minLength: 1,
      pattern: "^[a-z0-9][a-z0-9-]*$",
      description: "URL-safe slug used as the workflow trigger ref",
    }),
    name: Type.String({ minLength: 1, description: "Human-readable label" }),
    path: Type.String({ minLength: 1, description: "Directory path relative to WORK_DIR (e.g. 'inbox')" }),
    patterns: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Glob patterns for filename matching (e.g. ['*.png', '*.pdf'])",
    }),
    events: Type.Optional(
      Type.Array(FileWatcherEventTypeSchema, {
        minItems: 1,
        description: "File system event types to watch for (default: ['new'])",
      }),
    ),
    recursive: Type.Optional(Type.Boolean({ description: "Watch subdirectories recursively (default: false)" })),
    processExisting: Type.Optional(
      Type.Boolean({ description: "Emit events for files already present on start (default: false)" }),
    ),
    enabled: Type.Optional(Type.Boolean({ description: "Whether the watcher is active (default: true)" })),
  },
  { additionalProperties: false },
);

/** Schema for updating a file watcher via REST. All fields are optional. */
export const UpdateFileWatcherPayload = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, description: "Human-readable label" })),
    path: Type.Optional(Type.String({ minLength: 1, description: "Directory path relative to WORK_DIR" })),
    patterns: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Glob patterns for filename matching",
      }),
    ),
    events: Type.Optional(
      Type.Array(FileWatcherEventTypeSchema, {
        minItems: 1,
        description: "File system event types to watch for",
      }),
    ),
    recursive: Type.Optional(Type.Boolean({ description: "Watch subdirectories recursively" })),
    processExisting: Type.Optional(Type.Boolean({ description: "Emit events for files already present on start" })),
    enabled: Type.Optional(Type.Boolean({ description: "Whether the watcher is active" })),
  },
  { additionalProperties: false },
);
