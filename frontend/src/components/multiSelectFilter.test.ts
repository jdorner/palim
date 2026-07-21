import { describe, expect, test } from "bun:test";
import { filterMultiSelectItems } from "./multiSelectFilter";

describe("MultiSelect filter", () => {
  describe("Property 5: Multi-select filter correctness", () => {
    /**
     * Validates: Requirements 10.3, 10.4
     *
     * For any list of item names and any non-empty search string, the filter function
     * shall return exactly those items whose name contains the search string as a
     * case-insensitive substring, preserving the original sort order.
     */

    const CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ ";

    function randomString(maxLen: number): string {
      const len = Math.floor(Math.random() * maxLen) + 1;
      let result = "";
      for (let i = 0; i < len; i++) {
        result += CHARSET[Math.floor(Math.random() * CHARSET.length)];
      }
      return result;
    }

    function randomItems(maxCount: number): string[] {
      const count = Math.floor(Math.random() * maxCount) + 1;
      const items: string[] = [];
      for (let i = 0; i < count; i++) {
        items.push(randomString(20));
      }
      return items;
    }

    function randomSubset(items: string[]): string[] {
      return items.filter(() => Math.random() < 0.3);
    }

    /** Reference implementation for property verification. */
    function referenceFilter(items: string[], selected: string[], search: string, maxDisplay: number): string[] {
      const term = search.toLowerCase();
      const available = items.filter((item) => !selected.includes(item));
      if (!term) return available.slice(0, maxDisplay);
      return available.filter((item) => item.toLowerCase().includes(term)).slice(0, maxDisplay);
    }

    test("filter matches reference implementation for 200+ random inputs", () => {
      for (let i = 0; i < 250; i++) {
        const items = randomItems(30);
        const selected = randomSubset(items);
        const search = randomString(8);
        const maxDisplay = Math.floor(Math.random() * 60) + 1;

        const actual = filterMultiSelectItems(items, selected, search, maxDisplay);
        const expected = referenceFilter(items, selected, search, maxDisplay);

        if (actual.length !== expected.length || !actual.every((v, idx) => v === expected[idx])) {
          throw new Error(
            `Mismatch at iteration ${i}:\n` +
              `  items: ${JSON.stringify(items)}\n` +
              `  selected: ${JSON.stringify(selected)}\n` +
              `  search: ${JSON.stringify(search)}\n` +
              `  maxDisplay: ${maxDisplay}\n` +
              `  actual: ${JSON.stringify(actual)}\n` +
              `  expected: ${JSON.stringify(expected)}`,
          );
        }
      }
    });

    test("filter is case-insensitive", () => {
      for (let i = 0; i < 200; i++) {
        const items = randomItems(20);
        const selected: string[] = [];
        const search = randomString(5);
        const maxDisplay = 50;

        const resultLower = filterMultiSelectItems(items, selected, search.toLowerCase(), maxDisplay);
        const resultUpper = filterMultiSelectItems(items, selected, search.toUpperCase(), maxDisplay);

        expect(resultLower).toEqual(resultUpper);
      }
    });

    test("filter preserves original item order", () => {
      for (let i = 0; i < 200; i++) {
        const items = randomItems(25);
        const selected: string[] = [];
        const search = randomString(3);
        const maxDisplay = 100; // High cap so we see all matches

        const result = filterMultiSelectItems(items, selected, search, maxDisplay);

        // Verify each result item can be found in items at a strictly increasing index.
        // indexOf alone breaks on duplicates, so search forward from the last found position.
        let lastIdx = -1;
        for (let j = 0; j < result.length; j++) {
          const idx = items.indexOf(result[j], lastIdx + 1);
          if (idx === -1 || idx <= lastIdx) {
            throw new Error(
              `Order violation at iteration ${i}: "${result[j]}" not found after index ${lastIdx} in items.\n` +
                `  items: ${JSON.stringify(items)}\n` +
                `  search: ${JSON.stringify(search)}\n` +
                `  result: ${JSON.stringify(result)}`,
            );
          }
          lastIdx = idx;
        }
      }
    });

    test("selected items are always excluded from results", () => {
      for (let i = 0; i < 200; i++) {
        const items = randomItems(20);
        const selected = randomSubset(items);
        const search = Math.random() < 0.5 ? "" : randomString(4);
        const maxDisplay = 100;

        const result = filterMultiSelectItems(items, selected, search, maxDisplay);

        for (const item of result) {
          if (selected.includes(item)) {
            throw new Error(
              `Selected item "${item}" found in result at iteration ${i}.\n` +
                `  items: ${JSON.stringify(items)}\n` +
                `  selected: ${JSON.stringify(selected)}\n` +
                `  search: ${JSON.stringify(search)}`,
            );
          }
        }
      }
    });
  });

  describe("Property 6: Dropdown display cap", () => {
    /**
     * Validates: Requirement 10.8
     *
     * For any list of items with length > 50, the MultiSelect component shall render
     * at most 50 option elements in the dropdown list.
     */

    test("result never exceeds maxDisplay cap", () => {
      for (let i = 0; i < 200; i++) {
        // Generate lists larger than 50
        const count = 51 + Math.floor(Math.random() * 50);
        const items: string[] = [];
        for (let j = 0; j < count; j++) {
          items.push(`item-${j}-${Math.random().toString(36).slice(2, 6)}`);
        }
        const selected: string[] = [];
        const search = ""; // Empty search returns all available items
        const maxDisplay = 50;

        const result = filterMultiSelectItems(items, selected, search, maxDisplay);
        expect(result.length).toBeLessThanOrEqual(maxDisplay);
      }
    });

    test("result respects custom maxDisplay values", () => {
      for (let i = 0; i < 200; i++) {
        const count = 20 + Math.floor(Math.random() * 80);
        const items: string[] = [];
        for (let j = 0; j < count; j++) {
          items.push(`item-${j}`);
        }
        const selected: string[] = [];
        const search = Math.random() < 0.5 ? "" : "item";
        const maxDisplay = 1 + Math.floor(Math.random() * 30);

        const result = filterMultiSelectItems(items, selected, search, maxDisplay);
        expect(result.length).toBeLessThanOrEqual(maxDisplay);
      }
    });
  });
});
