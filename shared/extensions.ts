/**
 * Extension metadata and UI contribution types shared between backend and frontend.
 *
 * @module
 */

/** A navigation entry declared by an extension for sidebar rendering. */
export interface NavigationEntry {
  /** Display text in sidebar (1-50 characters). */
  label: string;
  /** Route path for navigation (starts with /, max 128 characters). */
  route: string;
  /** Icon component identifier (1-64 characters). */
  icon: string;
  /** Display position (ascending integer, 0-999). */
  order: number;
  /** Optional badge data source key. */
  badgeKey?: string;
  /** Optional Tailwind CSS class(es) for icon color. */
  iconColor?: string;
}

/** UI contribution data from an extension manifest. */
export interface ExtensionUiContribution {
  /** Navigation entries to render in the sidebar. */
  navigation: NavigationEntry[];
}

/** A single secret schema entry declared in an extension manifest. */
export interface SecretSchemaEntry {
  /** Secret key name (e.g. "API_KEY"). */
  key: string;
  /** Human-readable description of the secret's purpose. */
  description: string;
  /** Whether the secret is required for the extension to function. */
  required: boolean;
  /** Optional grouping label for related secrets. */
  group?: string;
}

/** Metadata for a loaded extension, including its enabled/disabled state. */
export interface ExtensionInfo {
  /** Extension manifest name. */
  name: string;
  /** Extension version string. */
  version: string;
  /** Human-readable description of what the extension does. */
  description: string;
  /** Whether the extension is enabled (visible to the agent). */
  enabled: boolean;
  /** Whether this is a core, built-in, or externally installed extension. */
  source: "core" | "builtin" | "external";
  /** When true, the extension is core infrastructure and cannot be disabled. */
  core: boolean;
  /** Number of agent tools registered by this extension. */
  toolCount: number;
  /** Number of HTTP routes registered by this extension. */
  routeCount: number;
  /** Number of job queues created by this extension. */
  queueCount: number;
  /** Number of skills provided by this extension. */
  skillCount: number;
  /** JSON Schema object describing configurable settings, or null if the extension has no settings. */
  settingsSchema: Record<string, unknown> | null;
  /** Declared secrets schema entries, or null if the extension has no secrets schema. */
  secretsSchema: SecretSchemaEntry[] | null;
  /** Error message from the last failed initialization attempt, or null if healthy. */
  error: string | null;
  /** UI contributions declared in the manifest, or null if none declared. */
  ui: ExtensionUiContribution | null;
}

/** WebSocket event broadcast when an extension is loaded, unloaded, activated, or deactivated at runtime. */
export interface ExtensionLifecycleEvent {
  type: "extension_lifecycle";
  /** The lifecycle action that occurred. */
  action: "loaded" | "unloaded" | "activated" | "deactivated";
  /** Extension manifest name. */
  name: string;
  /** Extension version string. */
  version: string;
}
