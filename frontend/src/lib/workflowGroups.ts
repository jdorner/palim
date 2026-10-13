/**
 * Grouping of the workflow list by the optional `group` field of a workflow
 * definition, plus the remembered collapsed state of the list's group sections.
 *
 * @module
 */

/** One section of the grouped workflow list. */
export interface WorkflowGroupSection<T> {
  /** Group name, or `null` for the workflows without a group. */
  group: string | null;
  /** The section's workflows, in input order. */
  items: T[];
}

/**
 * Splits workflows into sections by group: named groups sorted alphabetically,
 * the ungrouped workflows last. Items keep their input order within a section.
 *
 * @param workflows - Workflows to group (typically already sorted by name)
 * @returns The non-empty sections
 */
export function groupWorkflows<T extends { group?: string }>(workflows: T[]): WorkflowGroupSection<T>[] {
  const byGroup = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const wf of workflows) {
    const group = wf.group?.trim();
    if (!group) {
      ungrouped.push(wf);
      continue;
    }
    const items = byGroup.get(group);
    if (items) items.push(wf);
    else byGroup.set(group, [wf]);
  }
  const sections: WorkflowGroupSection<T>[] = [...byGroup.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((group) => ({ group, items: byGroup.get(group)! }));
  if (ungrouped.length > 0) sections.push({ group: null, items: ungrouped });
  return sections;
}

/** Run counters of a workflow, summed per section for the group subtotals. */
export interface WorkflowRunCounts {
  activeRuns: number;
  failedRuns: number;
  completedRuns: number;
}

/**
 * Sums the run counters of a section's workflows.
 *
 * @param items - The section's workflows
 * @returns The subtotals
 */
export function sumRunCounts(items: WorkflowRunCounts[]): WorkflowRunCounts {
  const totals: WorkflowRunCounts = { activeRuns: 0, failedRuns: 0, completedRuns: 0 };
  for (const wf of items) {
    totals.activeRuns += wf.activeRuns;
    totals.failedRuns += wf.failedRuns;
    totals.completedRuns += wf.completedRuns;
  }
  return totals;
}

/**
 * Key of a section in the collapsed-state set (`""` for the ungrouped section,
 * which a real group name cannot be since groups are trimmed and non-empty).
 *
 * @param group - Group name, or `null` for the ungrouped section
 * @returns The section key
 */
export function sectionKey(group: string | null): string {
  return group ?? "";
}

/** localStorage key of the collapsed group sections. */
const COLLAPSED_KEY = "palim.workflows.collapsedGroups";

/** @returns The keys of the collapsed sections, or an empty set when storage is unavailable. */
export function readCollapsedGroups(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Remembers the collapsed sections.
 *
 * @param collapsed - Keys of the collapsed sections
 */
export function writeCollapsedGroups(collapsed: Set<string>): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage unavailable (private mode, blocked): the state just isn't remembered.
  }
}
