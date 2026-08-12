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

/** Reactive dark mode state — tracks the `dark` class on <html>. */
let isDark = $state(document.documentElement.classList.contains("dark"));

// Observe class changes on <html> to detect theme toggles
$effect(() => {
  const observer = new MutationObserver(() => {
    isDark = document.documentElement.classList.contains("dark");
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
});

// Reload the page content when extension name changes
$effect(() => {
  if (extensionName) {
    loadPage(extensionName);
  }
});

// Re-inject theme when dark mode changes (without full reload)
$effect(() => {
  if (htmlContent && extensionName) {
    // isDark changed — rebuild the srcdoc with new theme vars
    rebuildWithTheme();
  }
});

/** Raw HTML fetched from the extension (without injected helpers). */
let rawHtml: string | null = $state(null);

/**
 * Builds the theme CSS variables string based on current dark/light state.
 */
function buildThemeVars(dark: boolean): string {
  return dark
    ? `--palim-bg:#020817;--palim-bg-alt:#1e293b;--palim-bg-surface:#0f172a;--palim-text:#f8fafc;--palim-text-muted:#94a3b8;--palim-border:#1e293b;--palim-accent:#3b82f6;--palim-accent-hover:#60a5fa;--palim-success:#22c55e;--palim-success-bg:#052e16;--palim-error:#ef4444;--palim-error-bg:#450a0a;--palim-warning:#f59e0b;--palim-warning-bg:#451a03;--palim-pending:#38bdf8;--palim-pending-bg:#0c2340;`
    : `--palim-bg:#ffffff;--palim-bg-alt:#f8f9fa;--palim-bg-surface:#ffffff;--palim-text:#1a1a1a;--palim-text-muted:#6b7280;--palim-border:#e5e7eb;--palim-accent:#2563eb;--palim-accent-hover:#1d4ed8;--palim-success:#16a34a;--palim-success-bg:#dcfce7;--palim-error:#dc2626;--palim-error-bg:#fef2f2;--palim-warning:#d97706;--palim-warning-bg:#fffbeb;--palim-pending:#0284c7;--palim-pending-bg:#f0f9ff;`;
}

/**
 * Builds the full helper injection (style + script) for the iframe.
 */
function buildHelper(token: string, dark: boolean): string {
  const scriptOpen = "<" + "script>";
  const scriptClose = "</" + "script>";
  const styleOpen = "<" + 'style id="palim-theme">';
  const styleClose = "</" + "style>";

  const themeStyle = `${styleOpen}:root{${buildThemeVars(dark)}}${styleClose}`;

  const helperJs = `${scriptOpen}
window.__palimToken = "${token}";
window.palim = {
  token: "${token}",
  fetch: function(path, opts) {
    opts = opts || {};
    var headers = Object.assign({"Content-Type": "application/json"}, opts.headers || {});
    if (window.__palimToken) headers["Authorization"] = "Bearer " + window.__palimToken;
    return fetch(path, Object.assign({}, opts, { headers: headers }));
  }
};
${scriptClose}`;

  return themeStyle + helperJs;
}

/**
 * Rebuilds the srcdoc with updated theme variables (no network request).
 */
function rebuildWithTheme() {
  if (!rawHtml) return;
  const token = getToken() ?? "";
  const helper = buildHelper(token, isDark);
  htmlContent = rawHtml.replace("<head>", `<head>${helper}`);
}

async function loadPage(name: string) {
  loading = true;
  error = null;
  htmlContent = null;
  rawHtml = null;
  try {
    const res = await authFetch(`/ext/${name}/ui`);
    if (!res.ok) {
      error = `Failed to load extension page: ${res.status} ${res.statusText}`;
      return;
    }
    rawHtml = await res.text();
    const token = getToken() ?? "";
    const helper = buildHelper(token, isDark);
    htmlContent = rawHtml.replace("<head>", `<head>${helper}`);
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
