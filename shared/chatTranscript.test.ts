import { describe, expect, test } from "bun:test";
import {
  messageText,
  sessionToChatMessages,
  summarizeToolCall,
  type TranscriptSourceMessage,
  titleFromMessage,
} from "./chatTranscript";

let seq = 0;
/** Builds a stored row with an increasing seq and timestamp. */
function row(role: string, content: unknown, extra: Partial<TranscriptSourceMessage> = {}): TranscriptSourceMessage {
  seq++;
  return { seq, clientId: null, role, content, timestamp: 1000 + seq, ...extra };
}

describe("summarizeToolCall", () => {
  test("shows the command of exec, the path of file tools, else the first string argument", () => {
    expect(summarizeToolCall("exec", { command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolCall("read_file", { path: "/a.txt" })).toBe("read_file /a.txt");
    expect(summarizeToolCall("web", { n: 3, query: "bun" })).toBe("bun");
    expect(summarizeToolCall("noop", { n: 3 })).toBe("noop");
    expect(summarizeToolCall("noop")).toBe("noop");
  });

  test("cuts long summaries to 80 characters", () => {
    const summary = summarizeToolCall("exec", { command: "x".repeat(200) });
    expect(summary).toHaveLength(80);
    expect(summary.endsWith("...")).toBe(true);
  });
});

describe("titleFromMessage / messageText", () => {
  test("trims and cuts titles to 50 characters", () => {
    expect(titleFromMessage("  hi  ")).toBe("hi");
    expect(titleFromMessage("y".repeat(60))).toHaveLength(50);
  });

  test("reads strings and text blocks", () => {
    expect(messageText("a")).toBe("a");
    expect(messageText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(messageText(42)).toBe("");
  });
});

describe("sessionToChatMessages", () => {
  test("turns everything between user messages into one assistant message", () => {
    const usage1 = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0 } };
    const usage2 = { input: 20, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 25 };
    const rows = [
      row("user", "list files", { clientId: "u1" }),
      row(
        "assistant",
        [
          { type: "thinking", thinking: "let me " },
          { type: "toolCall", id: "t1", name: "exec", arguments: { command: "ls" } },
        ],
        { usage: usage1 },
      ),
      row("toolResult", [{ type: "text", text: "a.txt" }]),
      row("assistant", [{ type: "toolCall", id: "t2", name: "read_file", arguments: { path: "a.txt" } }]),
      row("toolResult", [{ type: "text", text: "hello" }]),
      row(
        "assistant",
        [
          { type: "text", text: "There is " },
          { type: "text", text: "a.txt" },
        ],
        { usage: usage2 },
      ),
      row("user", "thanks", { clientId: "u2" }),
    ];

    const out = sessionToChatMessages(rows);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ id: "u1", role: "user", content: "list files" });
    expect(out[1]).toEqual({
      role: "assistant",
      content: "There is ",
      createdAt: out[1]!.createdAt,
      segments: [
        { type: "thinking", content: "let me " },
        {
          type: "tools",
          tools: [
            { name: "exec", summary: "ls" },
            { name: "read_file", summary: "read_file a.txt" },
          ],
        },
        { type: "text", content: "There is a.txt" },
      ],
      usage: { input: 20, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 25 },
    });
    expect(out[2]).toMatchObject({ id: "u2", role: "user", content: "thanks" });
  });

  test("a user message without a response yields no assistant message", () => {
    const out = sessionToChatMessages([row("user", "hi", { clientId: "u1" })]);
    expect(out).toEqual([{ id: "u1", role: "user", content: "hi", createdAt: out[0]!.createdAt }]);
  });

  test("push messages become push segments, also when no job ran", () => {
    const out = sessionToChatMessages([
      row("push", "before anything"),
      row("user", "hi", { clientId: "u1" }),
      row("assistant", [{ type: "text", text: "hello" }]),
      row("push", "**later**"),
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(out[0]!.segments).toEqual([{ type: "push", content: "before anything", contentType: "text/markdown" }]);
    expect(out[2]!.segments).toEqual([
      { type: "text", content: "hello" },
      { type: "push", content: "**later**", contentType: "text/markdown" },
    ]);
    expect(out[2]!.content).toBe("hello");
  });

  test("user messages without a client ID get a seq-based ID", () => {
    const r = row("user", "old");
    expect(sessionToChatMessages([r])[0]!.id).toBe(`legacy-${r.seq}`);
  });

  test("createdAt strictly increases even when timestamps repeat", () => {
    const out = sessionToChatMessages([
      row("user", "a", { clientId: "u1", timestamp: 5 }),
      row("assistant", [{ type: "text", text: "b" }], { timestamp: 5 }),
      row("user", "c", { clientId: "u2", timestamp: 4 }),
    ]);
    expect(out.map((m) => m.createdAt)).toEqual([5, 6, 7]);
  });

  test("ignores malformed content", () => {
    const out = sessionToChatMessages([
      row("user", "a", { clientId: "u1" }),
      row("assistant", [null, { type: "toolCall" }, { type: "text", text: "" }]),
      row("assistant", "plain"),
    ]);
    expect(out[1]).toMatchObject({ content: "plain", segments: [{ type: "text", content: "plain" }] });
  });
});
