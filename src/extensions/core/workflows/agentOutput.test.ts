import { describe, expect, test } from "bun:test";
import type { OutputSchemaShorthand } from "@shared/workflows";
import { outputInstruction, parseAgentOutput, repairInstruction } from "./agentOutput";

describe("parseAgentOutput", () => {
  const schema: OutputSchemaShorthand = {
    category: "string",
    score: "number",
    tags: ["string"],
    sender: { address: "string" },
  };

  test("parses a matching object, also inside a code fence and prose", () => {
    const answer =
      'Here you go:\n```json\n{"category":"ad","score":0.9,"tags":["x"],"sender":{"address":"a@b"},"extra":1}\n```';
    const result = parseAgentOutput(answer, schema);
    expect(result).toEqual({
      ok: true,
      value: { category: "ad", score: 0.9, tags: ["x"], sender: { address: "a@b" }, extra: 1 },
    });
  });

  test("reports missing fields and wrong types with their path", () => {
    const result = parseAgentOutput('{"score":"high","tags":[1],"sender":{}}', schema);
    expect(result).toEqual({
      ok: false,
      errors: [
        '"category" is missing',
        '"score" must be a number, got string',
        '"tags[0]" must be a string, got number',
        '"sender.address" is missing',
      ],
    });
  });

  test("rejects text without JSON and a top-level list", () => {
    expect(parseAgentOutput("It is an ad.", schema)).toEqual({
      ok: false,
      errors: ["the answer contains no JSON object"],
    });
    expect(parseAgentOutput('[{"category":"ad"}]', { category: "string" })).toEqual({
      ok: false,
      errors: ["the answer is a JSON list, not an object"],
    });
  });

  test('"any", "object" and unknown hints are lenient but present', () => {
    const loose = { a: "any", b: "object", c: "date" };
    expect(parseAgentOutput('{"a":null,"b":{"x":1},"c":5}', loose).ok).toBe(true);
    expect(parseAgentOutput('{"a":1,"b":[],"c":5}', loose)).toEqual({
      ok: false,
      errors: ['"b" must be an object, got a list'],
    });
    expect(parseAgentOutput('{"b":{}, "c":1}', loose)).toEqual({ ok: false, errors: ['"a" is missing'] });
  });

  test("takes the last matching object, not a repeated shape before it", () => {
    const one = { category: "string" };
    expect(parseAgentOutput('The format is {"category":"string"}. My answer: {"category":"ad"}', one)).toEqual({
      ok: true,
      value: { category: "ad" },
    });
    expect(parseAgentOutput('I checked sources [1] and [2]. {"category":"ad"}', one)).toEqual({
      ok: true,
      value: { category: "ad" },
    });
    // An earlier match is used when the later object does not match.
    expect(parseAgentOutput('{"category":"ad"} Note: {"confidence":0.5}', one)).toEqual({
      ok: true,
      value: { category: "ad" },
    });
  });

  test("a nested object is part of its parent, not a candidate", () => {
    const result = parseAgentOutput('Answer: {"sender":{"category":"x"},"category":"ad"}', { category: "string" });
    expect(result).toEqual({ ok: true, value: { sender: { category: "x" }, category: "ad" } });
  });

  test("reports the last object's mismatches when none matches", () => {
    expect(parseAgentOutput('{"category":1} then {"other":"x"}', { category: "string" })).toEqual({
      ok: false,
      errors: ['"category" is missing'],
    });
  });

  test('null passes only for "any"', () => {
    expect(parseAgentOutput('{"category":null}', { category: "string" })).toEqual({
      ok: false,
      errors: ['"category" must be a string, got null'],
    });
    expect(parseAgentOutput('{"category":null}', { category: "any" }).ok).toBe(true);
  });

  test("skips braces in prose that are not JSON", () => {
    expect(parseAgentOutput('Use {x} here. {"category":"ad"}', { category: "string" }).ok).toBe(true);
    expect(parseAgentOutput('{"category":"a}b"}', { category: "string" })).toEqual({
      ok: true,
      value: { category: "a}b" },
    });
  });

  test("caps the number of reported errors", () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, "string"]));
    const result = parseAgentOutput("{}", many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(5);
  });
});

describe("instructions", () => {
  test("outputInstruction names the shape", () => {
    expect(outputInstruction({ category: "string" })).toContain('{"category":"string"}');
  });

  test("repairInstruction lists the errors", () => {
    expect(repairInstruction(['"a" is missing'])).toContain('- "a" is missing');
  });
});
