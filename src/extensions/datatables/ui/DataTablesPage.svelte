<script lang="ts">
/**
 * Data Tables page: routes between the table list, table view, table editor,
 * and import wizard using the page sub-path.
 *
 * Sub-paths: "" (list), "new", "import" (?table=<name>), "t/<name>", "t/<name>/schema".
 */
import type { PalimHost } from "@ext/ui";
import ImportWizard from "./ImportWizard.svelte";
import TableForm from "./TableForm.svelte";
import TableList from "./TableList.svelte";
import TableView from "./TableView.svelte";

let { palim }: { palim: PalimHost } = $props();

let path = $state(palim.page.path);
let query = $state(palim.page.query);

$effect(() =>
  palim.page.subscribe((route) => {
    path = route.path;
    query = route.query;
  }),
);

const segments = $derived(path.split("/").filter(Boolean));
const tableName = $derived(segments[0] === "t" ? decodeURIComponent(segments[1] ?? "") : "");
const canWrite = $derived(palim.user.can("manage", "DataTable"));
</script>

<div class="space-y-4 p-1">
  {#if segments[0] === "new"}
    <TableForm {palim} />
  {:else if segments[0] === "import"}
    <ImportWizard {palim} initialTable={query.get("table") ?? ""} />
  {:else if tableName && segments[2] === "schema"}
    {#key tableName}
      <TableForm {palim} name={tableName} />
    {/key}
  {:else if tableName}
    {#key tableName}
      <TableView {palim} name={tableName} {canWrite} />
    {/key}
  {:else}
    <TableList {palim} {canWrite} />
  {/if}
</div>
