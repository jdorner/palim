<!--
  Small icon button next to a textarea's label that opens the text in a large
  editor dialog (see ExpandedTextEditor).
-->
<script lang="ts">
import ArrowsOutSimpleIcon from "phosphor-svelte/lib/ArrowsOutSimpleIcon";
import { t } from "$lib/i18n.svelte";

interface Props {
  /** Label of the field, used in the accessible name. */
  label: string;
  /** Opens the large editor. */
  onclick: () => void;
}

let { label, onclick }: Props = $props();
</script>

<button
  type="button"
  class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
  {onclick}
  aria-label={t("stepSidebar.expandField", { label })}
  title={t("stepSidebar.expand")}
>
  <ArrowsOutSimpleIcon size={14} aria-hidden="true" />
</button>
