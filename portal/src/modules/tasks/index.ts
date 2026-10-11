/**
 * The human tasks module: inbox and task pages.
 *
 * @module
 */

import CheckSquareIcon from "phosphor-svelte/lib/CheckSquareIcon";
import { session } from "$app/auth.svelte";
import type { PortalModule } from "../index";
import InboxPage from "./InboxPage.svelte";
import { tasks } from "./store.svelte";
import TaskPage from "./TaskPage.svelte";

/** Tasks module definition. */
export const tasksModule: PortalModule = {
  id: "tasks",
  nav: {
    path: "/tasks",
    labelKey: "nav.tasks",
    icon: CheckSquareIcon,
    badge: () => tasks.counts.open,
  },
  routes: [
    { pattern: "/tasks", component: InboxPage },
    { pattern: "/tasks/:id", component: TaskPage },
  ],
  isAvailable: () => session.canUseTasks,
  onEvent: (event) => tasks.handleEvent(event),
  reset: () => tasks.reset(),
};
