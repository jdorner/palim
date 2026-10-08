/**
 * Data Tables extension - user-defined, typed tables for workflows and agents.
 *
 * - Tables and their columns are defined in the "Data Tables" UI page, either
 *   by hand or by deriving the schema from a CSV/XLSX file.
 * - Data can be imported (CSV/XLSX), inspected, edited inline, and exported
 *   from the page.
 * - Workflow step types: `datatable-insert`, `datatable-update`,
 *   `datatable-delete`, `datatable-truncate`, `datatable-upsert`,
 *   `datatable-query`.
 * - The agent reads and writes rows with the `datatable` sandbox program.
 *
 * Rows are stored as JSON in the shared database (`ext_datatables_rows`), so
 * schema edits never need runtime DDL. Writes over HTTP require the
 * `datatables:write` permission.
 */

import type { Extension, ExtensionContext, ExtensionManifest } from "@ext/types";
import { requestUserId } from "@src/web/triggerOwnership";
import { registerRoutes } from "./routes";
import { createStepHandlers, TABLE_NAMES_PROVIDER } from "./steps";
import { DataTableStore } from "./store";
import { TABLE_CHANGED_EVENT, type TableChangedEvent } from "./types";

/** Minimum delay between change events for the same table. */
const EMIT_THROTTLE_MS = 500;

const manifest = {
  name: "datatables",
  version: "1.1.1",
  description: "Typed data tables with CSV/Excel import and export, workflow steps, and an agent command",
  dependencies: ["workflows"],
  ui: {
    pages: [{ id: "tables", title: "Data Tables", entry: "ui/DataTablesPage.svelte" }],
    navigation: [
      {
        label: "Data Tables",
        route: "/ext-page/datatables/tables",
        icon: "TableIcon",
        order: 35,
        iconColor: "text-teal-600 dark:text-teal-400",
      },
    ],
  },
} satisfies ExtensionManifest;

/**
 * Creates a per-table throttled emitter: the first change is sent right away,
 * further changes within the window are coalesced into one trailing event.
 *
 * @param emit - The underlying emit function
 * @returns The throttled emitter and a function cancelling pending timers
 */
export function createThrottledEmitter(emit: (event: TableChangedEvent) => void): {
  push: (event: TableChangedEvent) => void;
  cancel: () => void;
} {
  const windows = new Map<string, { timer: ReturnType<typeof setTimeout>; pending?: TableChangedEvent }>();
  const push = (event: TableChangedEvent) => {
    const open = windows.get(event.table);
    if (open) {
      open.pending = event;
      return;
    }
    emit(event);
    const state: { timer: ReturnType<typeof setTimeout>; pending?: TableChangedEvent } = {
      timer: setTimeout(() => {
        windows.delete(event.table);
        if (state.pending) push(state.pending);
      }, EMIT_THROTTLE_MS),
    };
    windows.set(event.table, state);
  };
  const cancel = () => {
    for (const { timer } of windows.values()) clearTimeout(timer);
    windows.clear();
  };
  return { push, cancel };
}

/**
 * Creates a fresh Data Tables extension instance.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let emitter: ReturnType<typeof createThrottledEmitter> | undefined;

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      emitter = createThrottledEmitter((event) => ctx.ui.emit(TABLE_CHANGED_EVENT, event));
      const store = new DataTableStore(ctx.db, { onChange: emitter.push });

      registerRoutes(ctx, store, requestUserId);

      ctx.dynamicItems.register(TABLE_NAMES_PROVIDER, () => store.tableNames());
      for (const [type, handler] of Object.entries(createStepHandlers(store))) {
        ctx.stepTypes.register(type, handler);
      }
      ctx.log.info(`[datatables] Ready (${store.tableNames().length} table(s))`);
    },

    async shutdown() {
      emitter?.cancel();
      emitter = undefined;
    },
  };
}

export default createExtension();
