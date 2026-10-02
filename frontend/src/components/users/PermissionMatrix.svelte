<script lang="ts">
import { groupPermissions } from "./userAdmin";

interface Props {
  /** The full permission catalog. */
  available: string[];
  /** The currently granted permissions. */
  selected: string[];
  /** Read-only display (no checkboxes can be changed). */
  readonly?: boolean;
}

let { available, selected = $bindable(), readonly = false }: Props = $props();

const groups = $derived(groupPermissions(available));

function toggle(perm: string) {
  selected = selected.includes(perm) ? selected.filter((p) => p !== perm) : [...selected, perm];
}

/** Grants every action on a resource, or revokes them all when already fully granted. */
function toggleRow(perms: Map<string, string>) {
  const rowPerms = [...perms.values()];
  const allOn = rowPerms.every((p) => selected.includes(p));
  selected = allOn ? selected.filter((p) => !rowPerms.includes(p)) : [...new Set([...selected, ...rowPerms])];
}
</script>

<div class="rounded-md border border-border overflow-x-auto">
  <table class="w-full text-sm">
    <thead>
      <tr class="border-b border-border text-xs text-muted-foreground">
        <th class="text-left font-medium px-3 py-2">Resource</th>
        {#each groups.actions as action}
          <th class="font-medium px-3 py-2 text-center w-20">{action}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each groups.resources as { resource, perms } (resource)}
        <tr class="border-b border-border last:border-0">
          <td class="px-3 py-1.5">
            {#if readonly}
              <span class="font-mono text-xs">{resource}</span>
            {:else}
              <button
                type="button"
                class="font-mono text-xs hover:underline"
                title="Toggle all {resource} permissions"
                onclick={() => toggleRow(perms)}
              >
                {resource}
              </button>
            {/if}
          </td>
          {#each groups.actions as action}
            {@const perm = perms.get(action)}
            <td class="px-3 py-1.5 text-center">
              {#if perm}
                <input
                  type="checkbox"
                  aria-label={perm}
                  checked={selected.includes(perm)}
                  disabled={readonly}
                  onchange={() => toggle(perm)}
                >
              {:else}
                <span class="text-muted-foreground/40" aria-hidden="true">—</span>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
