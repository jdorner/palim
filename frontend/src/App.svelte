<script lang="ts">
import ChatTextIcon from "phosphor-svelte/lib/ChatTextIcon";
import ClockIcon from "phosphor-svelte/lib/ClockIcon";
import EyeIcon from "phosphor-svelte/lib/EyeIcon";
import FlowArrowIcon from "phosphor-svelte/lib/FlowArrowIcon";
import GearIcon from "phosphor-svelte/lib/GearIcon";
import LinkIcon from "phosphor-svelte/lib/LinkIcon";
import PlugIcon from "phosphor-svelte/lib/PlugIcon";
import TrayIcon from "phosphor-svelte/lib/TrayIcon";
import { Router } from "sv-router";
import { onDestroy, onMount } from "svelte";
import { get } from "svelte/store";
import {
  connected,
  fetchFileWatcherCount,
  fetchWebhookCount,
  fetchWorkflowCount,
  hasConnected,
  jobs,
  schedules,
} from "$lib/appStore";
import { checkAuthRequired, forceLogout, registerDisconnect } from "$lib/auth";
import { chatStream } from "$lib/chatStreamStore.svelte";
import { Button } from "$lib/components/ui/button";
import { connectionManager } from "$lib/connectionStore.svelte";
import { extensions, fetchBadgesForEnabledExtensions, fetchExtensions } from "$lib/extensionStore";
import { readState } from "$lib/readState.svelte";
import { automationStyle } from "$lib/utils";
import { workflowStore } from "$lib/workflowRunStore.svelte";
import type { WebSocketMessage } from "../../shared/types";
import Sidebar from "./components/Sidebar.svelte";
import ConnectionError from "./lib/components/ConnectionError.svelte";
import ConnectionStatus from "./lib/components/ConnectionStatus.svelte";
import ThemeToggle from "./lib/components/ThemeToggle.svelte";
import { navigate, pathname } from "./router";

// Wire up the disconnect callback so auth.ts can close the WebSocket on logout
registerDisconnect(() => connectionManager.disconnect());

// Register the message handler before connecting
connectionManager.onMessage(handleMessage);

function handleMessage(message: WebSocketMessage) {
  switch (message.type) {
    case "initial_state":
      jobs.set(message.jobs);
      break;
    case "job_added":
      jobs.update((prev) => {
        const filtered = prev.filter((j) => j.id !== message.job.id);
        return [...filtered, message.job];
      });
      break;
    case "job_updated":
      jobs.update((prev) => prev.map((j) => (j.id === message.job.id ? message.job : j)));
      break;
    case "job_removed":
      jobs.update((prev) => prev.filter((j) => j.id !== message.jobId));
      break;
    case "job_log":
      jobs.update((prev) =>
        prev.map((j) => (j.id === message.jobId ? { ...j, logs: [...(j.logs || []), message.log] } : j)),
      );
      break;
    case "schedules_updated":
      schedules.set(message.schedules);
      break;
    case "chat_event":
      chatStream.handleChatEvent(message);
      break;
    case "feedback_report":
      chatStream.handleFeedbackReport(message);
      break;
    case "approval_request":
      chatStream.handleApprovalRequest(message);
      break;
    case "push_message":
      chatStream.handlePushMessage(message);
      break;
    case "webhooks_reload":
      fetchWebhookCount();
      break;
    case "filewatcher_reload":
      fetchFileWatcherCount();
      break;
    case "workflow_started":
    case "workflow_step_started":
    case "workflow_step_completed":
    case "workflow_step_failed":
    case "workflow_completed":
    case "workflow_failed":
      workflowStore.handleEvent(message);
      break;
    case "workflow_reload":
    case "workflow_deleted":
      workflowStore.handleEvent(message);
      fetchWorkflowCount();
      break;
    case "extension_lifecycle":
      fetchExtensions().then(() => {
        fetchBadgesForEnabledExtensions();
        if (message.action === "deactivated") {
          const currentPath = get(pathname);
          const allExtensions = get(extensions);
          const ext = allExtensions.find((e) => e.name === message.name);
          if (ext?.ui?.navigation) {
            const isOnExtRoute = ext.ui.navigation.some(
              (nav) => currentPath === nav.route || currentPath.startsWith(`${nav.route}/`),
            );
            if (isOnExtRoute) {
              navigate("/");
            }
          }
        }
      });
      break;
    default:
      console.warn("Unknown message type:", message);
  }
}

onMount(() => {
  if ($pathname !== "/login") {
    connectionManager.connect();
  }
});

onDestroy(() => {
  connectionManager.disconnect();
});

let isLoginPage = $derived($pathname === "/login");
let isChat = $derived($pathname === "/" || $pathname === "/chat" || $pathname.startsWith("/chat/"));
let isFullHeight = $derived(isChat);

// Connect when navigating away from login (after successful login),
// disconnect when navigating to login (logout).
$effect(() => {
  if (isLoginPage) {
    connectionManager.disconnect();
  } else {
    connectionManager.connect();
  }
});

let initialGracePeriod = $state(true);
$effect(() => {
  const timer = setTimeout(() => {
    initialGracePeriod = false;
  }, 500);
  return () => clearTimeout(timer);
});
let showConnectionError = $derived(!$connected && !$hasConnected && !isLoginPage && !initialGracePeriod);

let hasUnreadChats = $derived(chatStream.conversations.some((c) => readState.isUnread(c.id, c.updatedAt)));
</script>

{#if showConnectionError}
  <ConnectionError />
{:else}
  <div
    class={isLoginPage
    ? "min-h-screen"
    : `flex ${isFullHeight ? "h-screen overflow-hidden" : "min-h-screen"}`}
  >
    {#if !isLoginPage}
      <Sidebar jobCount={$jobs.length} scheduleCount={$schedules.length} {hasUnreadChats} />
    {/if}

    <div
      class={isLoginPage
      ? ""
      : `flex-1 min-w-0 p-6 ${isFullHeight ? "flex flex-col overflow-hidden" : ""}`}
    >
      {#if !isLoginPage}
        <header class="flex items-center justify-between mb-6">
          <h1 class="text-2xl font-bold flex items-center gap-2 pl-0.5">
            {#if $pathname === "/schedules"}
              <ClockIcon class="w-6 h-6 {automationStyle('schedule').color}" aria-hidden="true" />
              Schedules
            {:else if isChat}
              <ChatTextIcon class="w-6 h-6 {automationStyle('chat').color}" aria-hidden="true" />
              Chat
            {:else if $pathname === "/webhooks"}
              <LinkIcon class="w-6 h-6 {automationStyle('webhook').color}" aria-hidden="true" />
              Webhooks
            {:else if $pathname === "/filewatchers"}
              <EyeIcon class="w-6 h-6 {automationStyle('filewatcher').color}" aria-hidden="true" />
              File Watchers
            {:else if $pathname.startsWith("/workflows")}
              <FlowArrowIcon class="w-6 h-6 {automationStyle('workflow').color}" aria-hidden="true" />
              Workflows
            {:else if $pathname === "/settings"}
              <GearIcon class="w-6 h-6 " aria-hidden="true" />
              Settings
            {:else if $pathname === "/mcp"}
              <PlugIcon class="w-6 h-6 {automationStyle('mcp').color}" aria-hidden="true" />
              MCP Servers
            {:else}
              <TrayIcon class="w-6 h-6" aria-hidden="true" />
              Job Queues
            {/if}
          </h1>
          <div class="flex items-center gap-3">
            <ConnectionStatus connected={$connected} />
            <ThemeToggle />
            {#await checkAuthRequired() then isAuthRequired}
              {#if isAuthRequired}
                <Button
                  type="button"
                  variant="outline"
                  onclick={forceLogout}
                  class="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Logout
                </Button>
              {/if}
            {/await}
          </div>
        </header>
      {/if}

      <div class={isFullHeight ? "flex-1 min-h-0 flex flex-col overflow-hidden" : ""}><Router base="#" /></div>
    </div>
  </div>
{/if}
