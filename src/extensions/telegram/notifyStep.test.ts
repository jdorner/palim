import { describe, expect, test } from "bun:test";
import type { StepExecutionContext } from "@ext/types";
import { createNotifyStepHandler, type NotifyStepResult, type TelegramSendFn } from "./notifyStep";

/** Creates a minimal fake StepExecutionContext for testing. */
function createFakeContext(overrides?: Partial<StepExecutionContext>): StepExecutionContext {
  return {
    resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as StepExecutionContext["log"],
    workDir: "/tmp/test-work",
    jobLog: async () => {},
    workflowRunId: "test-run-123",
    ...overrides,
  };
}

/** Records the arguments passed to the send function and returns the resolved chat ID. */
function createRecordingSend(deliveredChatId = "999"): {
  send: TelegramSendFn;
  calls: { message: string; chatId?: string }[];
} {
  const calls: { message: string; chatId?: string }[] = [];
  const send: TelegramSendFn = async (message, chatId) => {
    calls.push({ message, chatId });
    return chatId || deliveredChatId;
  };
  return { send, calls };
}

describe("createNotifyStepHandler", () => {
  describe("outputSchema", () => {
    test("declares exactly the sent and chatId top-level properties (matching NotifyStepResult)", () => {
      const { send } = createRecordingSend();
      const handler = createNotifyStepHandler(send);

      expect(handler.outputSchema).toBeDefined();
      const properties = (handler.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties).sort()).toEqual(["chatId", "sent"]);
    });
  });

  describe("configuration validation", () => {
    test("throws when message is missing", async () => {
      const { send } = createRecordingSend();
      const handler = createNotifyStepHandler(send);
      const ctx = createFakeContext();

      await expect(handler.execute({ slug: "notify", type: "notify" }, ctx)).rejects.toThrow(
        /Invalid notify step configuration/,
      );
    });

    test("throws on unknown configuration fields", async () => {
      const { send } = createRecordingSend();
      const handler = createNotifyStepHandler(send);
      const ctx = createFakeContext();

      await expect(
        handler.execute({ slug: "notify", type: "notify", message: "hi", bogus: true }, ctx),
      ).rejects.toThrow(/Invalid notify step configuration/);
    });
  });

  describe("basic sending", () => {
    test("sends the message and returns delivered chat ID", async () => {
      const { send, calls } = createRecordingSend("555");
      const handler = createNotifyStepHandler(send);
      const ctx = createFakeContext();

      const result = await handler.execute({ slug: "notify", type: "notify", message: "hello" }, ctx);

      expect(calls.length).toBe(1);
      expect(calls[0]!.message).toBe("hello");
      expect(calls[0]!.chatId).toBeUndefined();
      expect(result).toEqual({ sent: true, chatId: "555" });
    });

    test("passes an explicit chat ID through to the send function", async () => {
      const { send, calls } = createRecordingSend();
      const handler = createNotifyStepHandler(send);
      const ctx = createFakeContext();

      const result = await handler.execute({ slug: "notify", type: "notify", message: "hi", chatId: "12345" }, ctx);

      expect(calls[0]!.chatId).toBe("12345");
      expect(result).toEqual({ sent: true, chatId: "12345" });
    });
  });

  describe("template resolution", () => {
    test("resolves template expressions in the message", async () => {
      const { send, calls } = createRecordingSend();
      const handler = createNotifyStepHandler(send);
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => ({
          resolved: template.replace("{{steps.build-message.result}}", "Alert: disk full"),
          warnings: [],
        }),
      });

      await handler.execute({ slug: "notify", type: "notify", message: "{{steps.build-message.result}}" }, ctx);

      expect(calls[0]!.message).toBe("Alert: disk full");
    });

    test("resolves template expressions in the chat ID", async () => {
      const { send, calls } = createRecordingSend();
      const handler = createNotifyStepHandler(send);
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => ({
          resolved: template.replace("{{trigger.payload.chat}}", "42"),
          warnings: [],
        }),
      });

      await handler.execute({ slug: "notify", type: "notify", message: "hi", chatId: "{{trigger.payload.chat}}" }, ctx);

      expect(calls[0]!.chatId).toBe("42");
    });

    test("treats an empty resolved chat ID as omitted (default fallback)", async () => {
      const { send, calls } = createRecordingSend("default-chat");
      const handler = createNotifyStepHandler(send);
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => ({
          // Mimics {{trigger.payload.chat|default:''}} resolving to empty
          resolved: template.includes("{{") ? "" : template,
          warnings: [],
        }),
      });

      const result = (await handler.execute(
        { slug: "notify", type: "notify", message: "hi", chatId: "{{trigger.payload.chat|default:''}}" },
        ctx,
      )) as NotifyStepResult;

      // message also gets resolved by the fake; guard the assertion on chatId only
      expect(calls[0]!.chatId).toBeUndefined();
      expect(result.chatId).toBe("default-chat");
    });

    test("logs template resolution warnings to the job log", async () => {
      const logged: string[] = [];
      const { send } = createRecordingSend();
      const handler = createNotifyStepHandler(send);
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => ({
          resolved: template,
          warnings: ["Unresolvable template path: steps.missing.result"],
        }),
        jobLog: async (msg: string) => {
          logged.push(msg);
        },
      });

      await handler.execute({ slug: "notify", type: "notify", message: "body" }, ctx);

      expect(logged.some((m) => m.includes("Unresolvable template path"))).toBe(true);
    });
  });

  describe("error handling", () => {
    test("throws when the resolved message is empty", async () => {
      const { send, calls } = createRecordingSend();
      const handler = createNotifyStepHandler(send);
      const ctx = createFakeContext({
        resolveTemplate: async () => ({ resolved: "   ", warnings: [] }),
      });

      await expect(handler.execute({ slug: "notify", type: "notify", message: "{{x}}" }, ctx)).rejects.toThrow(
        /resolved message is empty/,
      );
      expect(calls.length).toBe(0);
    });

    test("propagates send failures", async () => {
      const failingSend: TelegramSendFn = async () => {
        throw new Error("No chat_id provided and no default chat configured.");
      };
      const handler = createNotifyStepHandler(failingSend);
      const ctx = createFakeContext();

      await expect(handler.execute({ slug: "notify", type: "notify", message: "hi" }, ctx)).rejects.toThrow(
        /no default chat configured/,
      );
    });
  });
});
