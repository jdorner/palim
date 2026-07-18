import { describe, expect, test } from "bun:test";
import { EventBus } from "./eventBus";
import type { EventParam } from "./types";

describe("EventBus", () => {
  describe("scoped delivery", () => {
    test("event with extensionName is delivered only to the target extension", () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.subscribe("telegram", "settings:changed", () => {
        calls.push("telegram");
      });
      bus.subscribe("wiki", "settings:changed", () => {
        calls.push("wiki");
      });
      bus.subscribe("scheduler", "settings:changed", () => {
        calls.push("scheduler");
      });

      bus.dispatch({
        type: "settings:changed",
        extensionName: "telegram",
        values: { chatId: "123" },
      } as unknown as EventParam);

      expect(calls).toEqual(["telegram"]);
    });

    test("event without extensionName is delivered to all subscribers", () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.subscribe("telegram", "agent_start", () => {
        calls.push("telegram");
      });
      bus.subscribe("wiki", "agent_start", () => {
        calls.push("wiki");
      });
      bus.subscribe("scheduler", "agent_start", () => {
        calls.push("scheduler");
      });

      bus.dispatch({
        type: "agent_start",
      } as unknown as EventParam);

      expect(calls).toEqual(["telegram", "wiki", "scheduler"]);
    });

    test("non-string extensionName is treated as unscoped", () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.subscribe("telegram", "settings:changed", () => {
        calls.push("telegram");
      });
      bus.subscribe("wiki", "settings:changed", () => {
        calls.push("wiki");
      });

      bus.dispatch({
        type: "settings:changed",
        extensionName: undefined,
      } as unknown as EventParam);

      expect(calls).toEqual(["telegram", "wiki"]);
    });

    test("scoped event with no matching subscriber is silently dropped", () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.subscribe("telegram", "settings:changed", () => {
        calls.push("telegram");
      });

      bus.dispatch({
        type: "settings:changed",
        extensionName: "nonexistent",
      } as unknown as EventParam);

      expect(calls).toEqual([]);
    });
  });

  describe("scoped delivery with dispatchAwait", () => {
    test("dispatchAwait with extensionName only awaits the target extension", async () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.subscribe("telegram", "settings:changed", async () => {
        calls.push("telegram");
      });
      bus.subscribe("wiki", "settings:changed", async () => {
        calls.push("wiki");
      });

      await bus.dispatchAwait({
        type: "settings:changed",
        extensionName: "telegram",
      } as unknown as EventParam);

      expect(calls).toEqual(["telegram"]);
    });

    test("dispatchAwait without extensionName awaits all subscribers", async () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.subscribe("telegram", "agent_end", async () => {
        calls.push("telegram");
      });
      bus.subscribe("wiki", "agent_end", async () => {
        calls.push("wiki");
      });

      await bus.dispatchAwait({
        type: "agent_end",
      } as unknown as EventParam);

      expect(calls).toEqual(["telegram", "wiki"]);
    });
  });

  describe("unsubscribeAll", () => {
    test("removes all subscriptions for a given extension", () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.subscribe("telegram", "agent_start", () => {
        calls.push("telegram");
      });
      bus.subscribe("wiki", "agent_start", () => {
        calls.push("wiki");
      });

      bus.unsubscribeAll("telegram");

      bus.dispatch({ type: "agent_start" } as unknown as EventParam);

      expect(calls).toEqual(["wiki"]);
    });
  });
});
