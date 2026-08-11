<script lang="ts">
import { authFetch, getToken } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { route } from "../router";

// Extract extension name from route params
// Route: /ext-page/:extensionName
let extensionName = $derived(route.params.extensionName ?? "");

let htmlContent: string | null = $state(null);
let error: string | null = $state(null);
let loading = $state(true);

$effect(() => {
  if (extensionName) {
    loadPage(extensionName);
  }
});

async function loadPage(name: string) {
  loading = true;
  error = null;
  htmlContent = null;
  try {
    const res = await authFetch(`/ext/${name}/ui`);
    if (!res.ok) {
      error = `Failed to load extension page: ${res.status} ${res.statusText}`;
      return;
    }
    let html = await res.text();
    // Inject auth token so the iframe page can make authenticated API calls
    const token = getToken();
    if (token) {
      // Build the script injection without a literal closing script tag in source
      const scriptOpen = "<" + "script>";
      const scriptClose = "</" + "script>";
      const tokenScript = `${scriptOpen}window.__palimToken = "${token}";${scriptClose}`;
      html = html.replace("<head>", `<head>${tokenScript}`);
    }
    htmlContent = html;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load page";
  } finally {
    loading = false;
  }
}
</script>

{#if loading}
  <div class="flex items-center justify-center h-full">
    <LoadingIndicator message="Loading extension page..." />
  </div>
{:else if error}
  <div class="flex items-center justify-center h-full">
    <p class="text-sm text-destructive">{error}</p>
  </div>
{:else if htmlContent}
  <iframe
    srcdoc={htmlContent}
    class="w-full h-full border-0"
    sandbox="allow-scripts allow-same-origin allow-forms"
    title="Extension page: {extensionName}"
  ></iframe>
{/if}
