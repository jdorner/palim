/**
 * Pure filter logic extracted from MultiSelect.svelte for testability.
 *
 * Filters a list of items by removing already-selected items, then applying
 * a case-insensitive substring search, and finally capping the result at maxDisplay.
 *
 * @param items - Full list of available option names
 * @param selected - Currently selected items to exclude
 * @param search - Search string for filtering (empty string returns all available)
 * @param maxDisplay - Maximum number of items to return
 * @returns Filtered list of items matching the criteria
 */
export function filterMultiSelectItems(
  items: string[],
  selected: string[],
  search: string,
  maxDisplay: number,
): string[] {
  const term = search.toLowerCase();
  const available = items.filter((item) => !selected.includes(item));
  if (!term) return available.slice(0, maxDisplay);
  return available.filter((item) => item.toLowerCase().includes(term)).slice(0, maxDisplay);
}
