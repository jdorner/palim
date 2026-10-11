/**
 * The workflow launcher module: start a workflow by uploading a photo or file.
 *
 * @module
 */

import CameraIcon from "phosphor-svelte/lib/CameraIcon";
import { session } from "$app/auth.svelte";
import type { PortalModule } from "../index";
import LauncherListPage from "./LauncherListPage.svelte";
import LauncherPage from "./LauncherPage.svelte";
import { launchers } from "./store.svelte";

/** Launcher module definition. */
export const launchModule: PortalModule = {
  id: "launch",
  nav: {
    path: "/start",
    labelKey: "nav.start",
    icon: CameraIcon,
  },
  routes: [
    { pattern: "/start", component: LauncherListPage },
    { pattern: "/start/:name", component: LauncherPage },
  ],
  isAvailable: () => session.canStartWorkflows,
  reset: () => launchers.reset(),
};
