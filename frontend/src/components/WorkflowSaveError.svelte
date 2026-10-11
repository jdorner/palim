<script lang="ts">
/** Error box shown when saving a workflow fails, with the backend's per-item details. */
interface Props {
  /** Main error message. */
  error: string;
  /** Individual validation failures reported by the backend. */
  details: string[];
}

let { error, details }: Props = $props();
</script>

<div class="mb-4 px-3 py-2 rounded-md border border-destructive bg-destructive/10 text-sm text-destructive shrink-0">
  <div class="font-medium">{error}</div>
  {#if details.length > 0}
    <ul class="list-disc list-inside mt-1 space-y-0.5 text-xs text-destructive/90">
      {#each details as detail}
        <li>{detail}</li>
      {/each}
    </ul>
  {/if}
</div>
