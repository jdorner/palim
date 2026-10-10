/**
 * Display helpers for tasks.
 *
 * @module
 */

import { i18n, t } from "$app/i18n.svelte";
import type { HumanTask, HumanTaskUserRef } from "$shared/portal";

/**
 * Display name of a user.
 *
 * @param user - User reference
 * @returns Display name, else username, else "unknown user"
 */
export function userName(user: HumanTaskUserRef | null): string {
  return user ? (user.displayName ?? user.username) : t("tasks.unknownUser");
}

/**
 * Label of an outcome id as defined by the task.
 *
 * @param task - The task
 * @param outcome - Outcome id
 * @returns The outcome label (the id when unknown)
 */
export function outcomeLabel(task: HumanTask, outcome: string): string {
  return task.outcomes.find((o) => o.id === outcome)?.label ?? outcome;
}

/**
 * The due line of a task ("Due in 3 hours" / "Overdue since …"), or null.
 *
 * @param task - The task
 * @param now - Current time (epoch ms)
 * @returns The text, or null when the task has no due date or is closed
 */
export function dueText(task: HumanTask, now: number = Date.now()): string | null {
  if (task.dueAt === null || task.status !== "open") return null;
  const time = i18n.current.format.relative(task.dueAt, now);
  return task.dueAt < now ? t("tasks.overdue", { time }) : t("tasks.due", { time });
}

/**
 * Whether a task is due within 24 hours or overdue.
 *
 * @param task - The task
 * @param now - Current time (epoch ms)
 * @returns True when urgent
 */
export function isUrgent(task: HumanTask, now: number = Date.now()): boolean {
  return task.status === "open" && task.dueAt !== null && task.dueAt - now < 24 * 60 * 60 * 1000;
}
