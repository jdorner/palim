/**
 * Pure model of the workflow editor's step type picker: grouping into
 * sections, text filtering, and keyboard index movement. Kept free of Svelte
 * state so the picker's behaviour is unit-testable.
 */

/** A step type entry offered by the picker. */
export interface PickerStepType {
  /** Step type identifier (e.g. `http-request`). */
  type: string;
  /** Localized label. */
  label: string;
  /** Localized explanation of what the step does. */
  description?: string;
  /** Icon registry id (custom step types only). */
  icon?: string;
  /** Palette category (`control-flow` groups the entry under Control Flow). */
  category?: string;
}

/** A titled group of picker entries. */
export interface PickerSection {
  /** Section identifier, mapped to its heading by the component. */
  id: "steps" | "control-flow";
  /** Entries in display order. */
  items: PickerStepType[];
}

/** Options for {@link buildPickerSections}. */
export interface PickerSectionOptions {
  /** Whether to include the Control Flow section. */
  includeControlFlow: boolean;
  /** Whether human tasks are enabled on the server (gates `humanTask`). */
  hitlEnabled: boolean;
}

const byLabel = (a: PickerStepType, b: PickerStepType) => a.label.localeCompare(b.label);

/**
 * Groups built-in and custom step types into the picker's sections.
 *
 * Steps: built-in non-control-flow types in the given order, then custom action
 * types by label. Control Flow: built-in control-flow types by label, then
 * custom control-flow types by label. Custom types that reuse a built-in slug
 * are dropped; `humanTask` is only offered when HITL is enabled.
 *
 * @param builtins - Built-in step types (localized)
 * @param custom - Step types registered by extensions (localized)
 * @param options - Section options
 * @returns The non-empty sections in display order
 */
export function buildPickerSections(
  builtins: readonly PickerStepType[],
  custom: readonly PickerStepType[],
  options: PickerSectionOptions,
): PickerSection[] {
  const builtinSlugs = new Set(builtins.map((b) => b.type));
  // Human tasks are experimental and only offered when the server enables them.
  const offered = builtins.filter((b) => b.type !== "humanTask" || options.hitlEnabled);
  const customTypes = custom.filter((c) => !builtinSlugs.has(c.type));
  const isControlFlow = (st: PickerStepType) => st.category === "control-flow";

  const sections: PickerSection[] = [
    {
      id: "steps",
      items: [
        ...offered.filter((b) => !isControlFlow(b)),
        ...customTypes.filter((c) => !isControlFlow(c)).sort(byLabel),
      ],
    },
  ];
  if (options.includeControlFlow) {
    sections.push({
      id: "control-flow",
      items: [...offered.filter(isControlFlow).sort(byLabel), ...customTypes.filter(isControlFlow).sort(byLabel)],
    });
  }
  return sections.filter((s) => s.items.length > 0);
}

/**
 * Narrows the sections to entries whose label, description, or type contains
 * the query (case-insensitive). Sections left empty are dropped.
 *
 * @param sections - Sections from {@link buildPickerSections}
 * @param query - Filter text; blank returns the sections unchanged
 * @returns The filtered sections
 */
export function filterPickerSections(sections: readonly PickerSection[], query: string): PickerSection[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...sections];
  const matches = (st: PickerStepType) =>
    [st.label, st.description ?? "", st.type].some((text) => text.toLowerCase().includes(needle));
  return sections
    .map((section) => ({ ...section, items: section.items.filter(matches) }))
    .filter((section) => section.items.length > 0);
}

/**
 * Moves a list index by `delta`, wrapping around at both ends.
 *
 * @param current - Current index (negative when nothing is active)
 * @param delta - Steps to move (positive = down)
 * @param length - Number of entries
 * @returns The new index, or -1 when the list is empty
 */
export function movePickerIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (((current + delta) % length) + length) % length;
}
