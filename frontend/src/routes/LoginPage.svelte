<script lang="ts">
import { setToken } from "$lib/auth";
import { Button } from "$lib/components/ui/button";
import { identity } from "$lib/identity.svelte";
import { navigate } from "../router";

let username = $state("");
let password = $state("");
let error = $state("");
let submitting = $state(false);

async function handleSubmit() {
  error = "";
  submitting = true;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      const data = await res.json();
      setToken(data.token);
      identity.set(data.user, data.ability);
      navigate("/");
    } else if (res.status === 401) {
      error = "Invalid username or password.";
    } else if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after")) || 0;
      error = seconds
        ? `Too many attempts. Try again in ${seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`}.`
        : "Too many attempts. Please wait and try again.";
    } else {
      error = "Sign in failed. Please try again.";
    }
  } catch {
    error = "Could not reach the server.";
  } finally {
    submitting = false;
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !submitting) handleSubmit();
}
</script>

<div class="flex items-center justify-center min-h-screen bg-background">
  <div class="w-full max-w-sm p-6 space-y-6">
    <div class="text-center space-y-2">
      <h1 class="text-2xl font-bold">Sign In</h1>
      <p class="text-sm text-muted-foreground">Enter your username and password to continue.</p>
    </div>

    <div class="space-y-4">
      <div class="space-y-2">
        <label for="username" class="text-sm font-medium">Username</label>
        <input
          id="username"
          type="text"
          autocomplete="username"
          bind:value={username}
          onkeydown={handleKeydown}
          placeholder="Enter username"
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background
            placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-ring focus-visible:ring-offset-2"
          disabled={submitting}
        >
      </div>

      <div class="space-y-2">
        <label for="password" class="text-sm font-medium">Password</label>
        <input
          id="password"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          onkeydown={handleKeydown}
          placeholder="Enter password"
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background
            placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-ring focus-visible:ring-offset-2"
          disabled={submitting}
        >
      </div>

      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}

      <Button size="default" class="w-full" disabled={submitting || !username || !password} onclick={handleSubmit}>
        {submitting ? "Signing in..." : "Sign In"}
      </Button>
    </div>
  </div>
</div>
