/**
 * Shared, persisted preference for where workflow step details are shown:
 * docked in a right-hand sidebar, or in a floating panel anchored beneath the
 * selected graph node (experimental). Used by the workflow detail and run
 * pages so both follow the same choice. Backed by localStorage.
 */

export type DetailPanelMode = "sidebar" | "floating";

const STORAGE_KEY = "palim.workflowDetailPanelMode";

/**
 * Read the persisted mode, falling back to the sidebar.
 *
 * @returns The stored mode, or "sidebar" when unset or storage is unavailable
 */
function load(): DetailPanelMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "floating" ? "floating" : "sidebar";
  } catch {
    return "sidebar";
  }
}

let mode = $state<DetailPanelMode>(load());

/** Reactive detail panel mode store. */
export const detailPanelMode = {
  /** The current mode. */
  get current(): DetailPanelMode {
    return mode;
  },

  /** Switch between the docked sidebar and the floating node panel, persisting the choice. */
  toggle(): void {
    mode = mode === "sidebar" ? "floating" : "sidebar";
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Storage unavailable (private mode etc.): keep the in-memory choice.
    }
  },
};
