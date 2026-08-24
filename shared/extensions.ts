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
  /** Custom workflow step types registered by this extension. */
  stepTypes?: StepTypeInfo[];
}

/**
 * Canonical set of icon identifiers that a custom workflow step type may use.
 *
 * This is the single source of truth for step icon names, shared between the
 * backend (extension step handlers) and the frontend icon registry
 * (`frontend/src/lib/iconRegistry.ts`), which maps each name to a phosphor
 * component. Adding a name here requires adding the matching component to the
 * registry, or the frontend will fail to type-check.
 *
 * Each name corresponds to a `phosphor-svelte` icon component.
 */
export const STEP_ICON_NAMES = [
  "BroadcastIcon",
  "ChatTextIcon",
  "ClockIcon",
  "DatabaseIcon",
  "EnvelopeIcon",
  "EyeIcon",
  "FileTextIcon",
  "FlowArrowIcon",
  "GearIcon",
  "GlobeIcon",
  "LinkIcon",
  "PaperPlaneTiltIcon",
  "PlugIcon",
  "ProhibitIcon",
  "ReceiptIcon",
  "RobotIcon",
  "TableIcon",
  "TerminalWindowIcon",
  "TrayIcon",
] as const;

/**
 * A valid step icon identifier. A key into the frontend icon registry
 * (`frontend/src/lib/iconRegistry.ts`).
 */
export type StepIconName = (typeof STEP_ICON_NAMES)[number];

/**
 * Metadata about a registered custom workflow step type.
 * Surfaced to the frontend for workflow editor UI rendering.
 */
export interface StepTypeInfo {
  /** The step type identifier (e.g. "excel"). */
  type: string;
  /** Human-readable label (e.g. "Excel Writer"). */
  label: string;
  /**
   * Optional icon identifier. A key into the frontend icon registry
   * (`frontend/src/lib/iconRegistry.ts`), e.g. `"TableIcon"`, not an emoji.
   */
  icon?: StepIconName;
  /** Name of the extension that registered this step type. */
  extensionName: string;
  /**
   * When true, this step type is a terminal node (e.g. fail) that never
   * produces a successor in the workflow graph.
   */
  terminal?: boolean;
  /** JSON Schema describing the step's configuration fields (derived from the handler's TypeBox schema). */
  configSchema?: Record<string, unknown>;
  /**
   * JSON Schema describing the step's result (its output shape), when the
   * handler declares one. Distinct from `configSchema`, which describes the
   * step's input configuration fields. Undefined when the handler does not
   * declare an output schema.
   */
  outputSchema?: Record<string, unknown>;
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
