/**
 * Reactive user settings store backed by localStorage.
 * Provides UI preferences that persist across sessions.
 */

const STORAGE_KEY = "app_settings";

interface Settings {
  /** Whether thinking blocks should be expanded by default. */
  thinkingExpanded: boolean;
  /** Whether the sidebar is collapsed (icon-only mode). */
  sidebarCollapsed: boolean;
}

const DEFAULTS: Settings = {
  thinkingExpanded: false,
  sidebarCollapsed: false,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    // Ignore parse errors, use defaults
  }
  return { ...DEFAULTS };
}

function persist(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors (e.g. quota exceeded)
  }
}

/**
 * Reactive settings store exposed as a Svelte 5 class with `$state` fields.
 * A single module-level instance (`settings`) is exported for global use.
 */
class SettingsStore {
  /** Whether thinking blocks should be expanded by default in the chat UI. */
  thinkingExpanded = $state(false);

  /** Whether the sidebar is collapsed to icon-only mode. */
  sidebarCollapsed = $state(false);

  constructor() {
    const loaded = loadSettings();
    this.thinkingExpanded = loaded.thinkingExpanded;
    this.sidebarCollapsed = loaded.sidebarCollapsed;
  }

  /** Toggles the thinking expanded preference and persists it. */
  toggleThinkingExpanded(): void {
    this.thinkingExpanded = !this.thinkingExpanded;
    this.#persist();
  }

  /** Sets the thinking expanded preference directly. */
  setThinkingExpanded(value: boolean): void {
    this.thinkingExpanded = value;
    this.#persist();
  }

  /** Toggles the sidebar collapsed state and persists it. */
  toggleSidebarCollapsed(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.#persist();
  }

  /** Sets the sidebar collapsed state directly. */
  setSidebarCollapsed(value: boolean): void {
    this.sidebarCollapsed = value;
    this.#persist();
  }

  #persist(): void {
    persist({
      thinkingExpanded: this.thinkingExpanded,
      sidebarCollapsed: this.sidebarCollapsed,
    });
  }
}

/** Singleton settings store instance. */
export const settings = new SettingsStore();
