import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { findUndeclaredConfigKeys, getUndeclaredConfigKeyWarnings } from "./configKeys";
import type { DagWorkflowDefinition } from "./schemas";

const Search = Type.Object(
  { seen: Type.Optional(Type.Boolean()), from: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

/** A config schema shaped like `imap-fetch` before its fix: `Composite` drops the nested `additionalProperties: false`. */
const SCHEMA = Type.Object(
  {
    account: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer()),
    search: Type.Optional(Type.Composite([Search], { title: "Search" })),
    closed: Type.Optional(Search),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    anything: Type.Optional(Type.Object({ known: Type.Optional(Type.String()) }, { additionalProperties: true })),
    typed: Type.Optional(Type.Object({ known: Type.Optional(Type.String()) }, { additionalProperties: Type.Number() })),
    rows: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
    either: Type.Optional(Type.Union([Type.Object({ a: Type.String() }), Type.Null()])),
    empty: Type.Optional(Type.Object({})),
  },
  { additionalProperties: false },
);

const paths = (config: Record<string, unknown>) =>
  findUndeclaredConfigKeys({ type: "imap-fetch", ...config }, SCHEMA).map((k) => k.path);

describe("findUndeclaredConfigKeys", () => {
  test("the test schema really has the open nested object", () => {
    expect((SCHEMA.properties.search as { additionalProperties?: unknown }).additionalProperties).toBeUndefined();
  });

  test("finds an undeclared key in a nested object and lists the declared ones", () => {
    expect(findUndeclaredConfigKeys({ type: "imap-fetch", search: { unseen: true, seen: false } }, SCHEMA)).toEqual([
      { path: "search.unseen", declared: ["seen", "from"], rejectedBySchema: false },
    ]);
  });

  test("marks keys the schema itself rejects", () => {
    expect(findUndeclaredConfigKeys({ type: "imap-fetch", bogus: 1, closed: { Seen: true } }, SCHEMA)).toEqual([
      { path: "bogus", declared: Object.keys(SCHEMA.properties), rejectedBySchema: true },
      { path: "closed.Seen", declared: ["seen", "from"], rejectedBySchema: true },
    ]);
  });

  test("looks into array items", () => {
    expect(paths({ rows: [{ name: "a" }, { name: "b", nme: "c" }] })).toEqual(["rows[1].nme"]);
  });

  test("skips objects left open on purpose, unions, and objects without declared fields", () => {
    expect(
      paths({
        headers: { "X-Any": "1" },
        anything: { other: 1 },
        typed: { other: 1 },
        either: { b: 1 },
        empty: { x: 1 },
      }),
    ).toEqual([]);
  });

  test("ignores type, slug and outputSchema, and a template where an object is expected", () => {
    expect(paths({ slug: "fetch", outputSchema: { x: "string" }, search: "{{trigger.payload.search}}" })).toEqual([]);
  });

  test("returns nothing without a schema", () => {
    expect(findUndeclaredConfigKeys({ type: "x", a: 1 }, undefined)).toEqual([]);
  });
});

describe("getUndeclaredConfigKeyWarnings", () => {
  const def = (step: Record<string, unknown>): DagWorkflowDefinition => ({
    name: "keys",
    trigger: { type: "manual" },
    steps: { "fetch-mails": step as never, plan: { type: "agent", prompt: "x" } },
    edges: [],
  });
  const getSchema = (type: string) => (type === "imap-fetch" ? SCHEMA : undefined);

  test("warns on the step, with the key path as field and the declared fields", () => {
    expect(getUndeclaredConfigKeyWarnings(def({ type: "imap-fetch", search: { Seen: false } }), getSchema)).toEqual([
      {
        stepSlug: "fetch-mails",
        field: "search.Seen",
        message:
          'Step "fetch-mails" sets "search.Seen", which imap-fetch does not declare. Declared fields: seen, from. Run: workflow step-types imap-fetch',
      },
    ]);
  });

  test("leaves keys the schema check already rejects to that check", () => {
    expect(getUndeclaredConfigKeyWarnings(def({ type: "imap-fetch", bogus: 1 }), getSchema)).toEqual([]);
  });

  test("cuts a long list of declared fields", () => {
    const many = Type.Object({
      nested: Type.Composite([
        Type.Object(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`f${i}`, Type.String()]))),
      ]),
    });
    const [warning] = getUndeclaredConfigKeyWarnings(def({ type: "wide", nested: { nope: 1 } }), () => many);
    expect(warning!.message).toContain("f10, f11 and 2 more. Run:");
  });

  test("is silent for step types without a config schema and for clean steps", () => {
    expect(getUndeclaredConfigKeyWarnings(def({ type: "unknown", whatever: 1 }), getSchema)).toEqual([]);
    expect(getUndeclaredConfigKeyWarnings(def({ type: "imap-fetch", search: { seen: false } }), getSchema)).toEqual([]);
  });
});
