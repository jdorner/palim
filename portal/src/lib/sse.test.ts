import { describe, expect, test } from "bun:test";
import { createSseParser, type SseMessage } from "./sse";

describe("createSseParser", () => {
  test("parses events split across chunks and skips comments", () => {
    const messages: SseMessage[] = [];
    const parse = createSseParser((m) => messages.push(m));

    parse('event: ready\ndata: {"a"');
    parse(":1}\n\n: ping\n\n");
    parse('data: plain\n\nevent: task_removed\r\ndata: {"taskId":"x"}\r\n\r\n');

    expect(messages).toEqual([
      { event: "ready", data: '{"a":1}' },
      { event: "message", data: "plain" },
      { event: "task_removed", data: '{"taskId":"x"}' },
    ]);
  });

  test("joins multi-line data", () => {
    const messages: SseMessage[] = [];
    createSseParser((m) => messages.push(m))("data: a\ndata: b\n\n");
    expect(messages).toEqual([{ event: "message", data: "a\nb" }]);
  });
});
