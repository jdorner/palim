import { describe, expect, test } from "bun:test";
import type { StepExecutionContext } from "@ext/types";
import { InMemoryFs } from "just-bash";
import { createNotifyStepHandler, type NotifyStepResult, type NtfySendConfig, type NtfySendFn } from "./notifyStep";

/** Creates a minimal fake StepExecutionContext for testing. */
function createFakeContext(overrides?: Partial<StepExecutionContext>): StepExecutionContext {
	return {
		resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
		log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as StepExecutionContext["log"],
		workDir: "/tmp/test-work",
		fs: new InMemoryFs(),
		jobLog: async () => {},
		workflowRunId: "test-run-123",
		...overrides,
	};
}

/** Records the config passed to the send function and returns the resolved topic. */
function createRecordingSend(deliveredTopic = "alerts"): {
	send: NtfySendFn;
	calls: NtfySendConfig[];
} {
	const calls: NtfySendConfig[] = [];
	const send: NtfySendFn = async (config) => {
		calls.push(config);
		return config.topic || deliveredTopic;
	};
	return { send, calls };
}

describe("createNotifyStepHandler", () => {
	describe("outputSchema", () => {
		test("declares exactly the sent and topic top-level properties (matching NotifyStepResult)", () => {
			const { send } = createRecordingSend();
			const handler = createNotifyStepHandler(send);

			expect(handler.outputSchema).toBeDefined();
			const properties = (handler.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
			expect(Object.keys(properties).sort()).toEqual(["sent", "topic"]);
		});
	});

	describe("configuration validation", () => {
		test("throws when message is missing", async () => {
			const { send } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext();

			await expect(handler.execute({ slug: "notify", type: "notify-ntfy" }, ctx)).rejects.toThrow(
				/Invalid notify-ntfy step configuration/,
			);
		});

		test("throws on unknown configuration fields", async () => {
			const { send } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext();

			await expect(
				handler.execute({ slug: "notify", type: "notify-ntfy", message: "hi", bogus: true }, ctx),
			).rejects.toThrow(/Invalid notify-ntfy step configuration/);
		});

		test("throws on an out-of-range priority (string)", async () => {
			const { send } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext();

			await expect(
				handler.execute({ slug: "notify", type: "notify-ntfy", message: "hi", priority: "9" }, ctx),
			).rejects.toThrow(/Invalid notify-ntfy step configuration/);
		});

		test("throws on a numeric priority (editor always sends strings)", async () => {
			const { send } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext();

			await expect(
				handler.execute({ slug: "notify", type: "notify-ntfy", message: "hi", priority: 5 }, ctx),
			).rejects.toThrow(/Invalid notify-ntfy step configuration/);
		});
	});

	describe("basic sending", () => {
		test("sends the message and returns delivered topic", async () => {
			const { send, calls } = createRecordingSend("system");
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext();

			const result = await handler.execute({ slug: "notify", type: "notify-ntfy", message: "hello" }, ctx);

			expect(calls.length).toBe(1);
			expect(calls[0]!.message).toBe("hello");
			expect(calls[0]!.topic).toBeUndefined();
			expect(result).toEqual({ sent: true, topic: "system" });
		});

		test("passes an explicit topic through to the send function", async () => {
			const { send, calls } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext();

			const result = await handler.execute(
				{ slug: "notify", type: "notify-ntfy", message: "hi", topic: "backups" },
				ctx,
			);

			expect(calls[0]!.topic).toBe("backups");
			expect(result).toEqual({ sent: true, topic: "backups" });
		});

		test("forwards title, priority, and tags to the send function", async () => {
			const { send, calls } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext();

			await handler.execute(
				{
					slug: "notify",
					type: "notify-ntfy",
					message: "disk full",
					title: "Alert",
					click: "https://example.com/dashboard",
					markdown: true,
					priority: "5",
					tags: ["warning", "skull"],
				},
				ctx,
			);

			expect(calls[0]!.title).toBe("Alert");
			expect(calls[0]!.click).toBe("https://example.com/dashboard");
			expect(calls[0]!.markdown).toBe(true);
			expect(calls[0]!.priority).toBe(5);
			expect(calls[0]!.tags).toEqual(["warning", "skull"]);
		});

		test("omits markdown when not set (defaults to plain text)", async () => {
			const { send, calls } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext();

			await handler.execute({ slug: "notify", type: "notify-ntfy", message: "**hi**" }, ctx);

			expect(calls[0]!.markdown).toBeUndefined();
		});

		test("accepts a string priority and normalizes it to a number", async () => {
			const { send, calls } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext();

			// The workflow editor serializes select/number inputs as strings.
			await handler.execute({ slug: "notify", type: "notify-ntfy", message: "hi", priority: "4" }, ctx);

			expect(calls[0]!.priority).toBe(4);
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

			await handler.execute(
				{ slug: "notify", type: "notify-ntfy", message: "{{steps.build-message.result}}" },
				ctx,
			);

			expect(calls[0]!.message).toBe("Alert: disk full");
		});

		test("resolves template expressions in the topic", async () => {
			const { send, calls } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext({
				resolveTemplate: async (template: string) => ({
					resolved: template.replace("{{trigger.payload.topic}}", "urgent"),
					warnings: [],
				}),
			});

			await handler.execute(
				{ slug: "notify", type: "notify-ntfy", message: "hi", topic: "{{trigger.payload.topic}}" },
				ctx,
			);

			expect(calls[0]!.topic).toBe("urgent");
		});

		test("resolves template expressions in the click URL", async () => {
			const { send, calls } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext({
				resolveTemplate: async (template: string) => ({
					resolved: template.replace("{{trigger.payload.url}}", "https://example.com/run/42"),
					warnings: [],
				}),
			});

			await handler.execute(
				{ slug: "notify", type: "notify-ntfy", message: "hi", click: "{{trigger.payload.url}}" },
				ctx,
			);

			expect(calls[0]!.click).toBe("https://example.com/run/42");
		});

		test("resolves template expressions in the title", async () => {
			const { send, calls } = createRecordingSend();
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext({
				resolveTemplate: async (template: string) => ({
					resolved: template.replace("{{trigger.payload.host}}", "web-01"),
					warnings: [],
				}),
			});

			await handler.execute(
				{ slug: "notify", type: "notify-ntfy", message: "hi", title: "Host {{trigger.payload.host}}" },
				ctx,
			);

			expect(calls[0]!.title).toBe("Host web-01");
		});

		test("treats an empty resolved topic as omitted (default fallback)", async () => {
			const { send, calls } = createRecordingSend("default-topic");
			const handler = createNotifyStepHandler(send);
			const ctx = createFakeContext({
				resolveTemplate: async (template: string) => ({
					// Mimics {{trigger.payload.topic|default:''}} resolving to empty
					resolved: template.includes("{{") ? "" : template,
					warnings: [],
				}),
			});

			const result = (await handler.execute(
				{ slug: "notify", type: "notify-ntfy", message: "hi", topic: "{{trigger.payload.topic|default:''}}" },
				ctx,
			)) as NotifyStepResult;

			// message also gets resolved by the fake; guard the assertion on topic only
			expect(calls[0]!.topic).toBeUndefined();
			expect(result.topic).toBe("default-topic");
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

			await handler.execute({ slug: "notify", type: "notify-ntfy", message: "body" }, ctx);

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

			await expect(handler.execute({ slug: "notify", type: "notify-ntfy", message: "{{x}}" }, ctx)).rejects.toThrow(
				/resolved message is empty/,
			);
			expect(calls.length).toBe(0);
		});

		test("propagates send failures", async () => {
			const failingSend: NtfySendFn = async () => {
				throw new Error("No topic provided and no default topic configured.");
			};
			const handler = createNotifyStepHandler(failingSend);
			const ctx = createFakeContext();

			await expect(handler.execute({ slug: "notify", type: "notify-ntfy", message: "hi" }, ctx)).rejects.toThrow(
				/no default topic configured/,
			);
		});
	});
});
