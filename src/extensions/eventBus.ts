/**
 * Extension event bus - pub/sub system for broadcasting agent lifecycle and
 * domain events to extension callbacks.
 *
 * Uses a flat subscription list per event type. Extension scoping is tracked
 * so {@link unsubscribeAll} can tear down a single extension's listeners.
 */

import createLogger from "logging";
import type { EventCallback, EventParam, EventType } from "./types";

const logger = createLogger("EventBus");

/** A single subscription entry. */
interface Subscription {
  extensionName: string;
  callback: EventCallback;
}

/**
 * Lightweight pub/sub bus for agent lifecycle and domain events.
 */
export class EventBus {
  private subscriptions = new Map<EventType, Subscription[]>();

  /**
   * Register a callback for a specific event type, scoped to an extension.
   *
   * @param extensionName - Name of the subscribing extension
   * @param eventType - Event type to subscribe to
   * @param callback - Callback invoked when the event fires
   */
  subscribe(extensionName: string, eventType: EventType, callback: EventCallback): void {
    let subs = this.subscriptions.get(eventType);
    if (!subs) {
      subs = [];
      this.subscriptions.set(eventType, subs);
    }
    subs.push({ extensionName, callback });
  }

  /**
   * Remove all subscriptions for a given extension across all event types.
   *
   * @param extensionName - Name of the extension to unsubscribe
   */
  unsubscribeAll(extensionName: string): void {
    for (const [eventType, subs] of this.subscriptions) {
      const filtered = subs.filter((s) => s.extensionName !== extensionName);
      if (filtered.length === 0) {
        this.subscriptions.delete(eventType);
      } else {
        this.subscriptions.set(eventType, filtered);
      }
    }
  }

  /**
   * Dispatch an event to all registered callbacks for that event type.
   * If the event payload contains a string `extensionName` property, delivery
   * is scoped to subscribers belonging to that extension only.
   * Catches and logs errors from individual callbacks so one bad handler
   * never blocks the rest.
   *
   * @param event - Event to dispatch
   */
  dispatch(event: EventParam): void {
    const subs = this.subscriptions.get(event.type as EventType);
    if (!subs) return;

    // Scoped delivery: if event targets a specific extension, only deliver to that extension
    const targetName =
      "extensionName" in event && typeof event.extensionName === "string" ? event.extensionName : undefined;

    for (const { extensionName, callback } of subs) {
      if (targetName && extensionName !== targetName) continue;

      try {
        const result = callback(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            logger.error(`Async error in "${event.type}" callback from extension "${extensionName}":`, err);
          });
        }
      } catch (err) {
        logger.error(`Error in "${event.type}" callback from extension "${extensionName}":`, err);
      }
    }
  }

  /**
   * Dispatch an event and sequentially await each handler before proceeding
   * to the next. Use for events where handlers mutate the event payload
   * (e.g. `before_agent_start`) and order/completion matters.
   *
   * If the event payload contains a string `extensionName` property, delivery
   * is scoped to subscribers belonging to that extension only.
   *
   * Errors in individual handlers are logged but do not prevent subsequent
   * handlers from running.
   *
   * @param event - Event to dispatch (handlers may mutate it)
   */
  async dispatchAwait(event: EventParam): Promise<void> {
    const subs = this.subscriptions.get(event.type as EventType);
    if (!subs) return;

    // Scoped delivery: if event targets a specific extension, only deliver to that extension
    const targetName =
      "extensionName" in event && typeof event.extensionName === "string" ? event.extensionName : undefined;

    for (const { extensionName, callback } of subs) {
      if (targetName && extensionName !== targetName) continue;

      try {
        await callback(event);
      } catch (err) {
        logger.error(`Error in awaited "${event.type}" callback from extension "${extensionName}":`, err);
      }
    }
  }
}
