/**
 * Tests for resolveHandlerOutputSchema - the helper that collapses a step-type
 * handler's `outputSchema` (static TypeBox schema OR config-derived function)
 * into a single concrete schema for a given step instance.
 */

import { describe, expect, test } from "bun:test";
import { type TSchema, Type } from "@sinclair/typebox";
import { resolveHandlerOutputSchema } from "./stepTypeSerialization";

describe("resolveHandlerOutputSchema", () => {
  describe("static form", () => {
    test("returns the static schema unchanged regardless of stepDef", () => {
      const schema = Type.Object({ status: Type.Number() });
      const resolved = resolveHandlerOutputSchema(schema, { some: "config" });
      expect(resolved).toBe(schema);
    });

    test("ignores stepDef contents for the static form", () => {
      const schema = Type.Object({ ok: Type.Boolean() });
      expect(resolveHandlerOutputSchema(schema, {})).toBe(schema);
      expect(resolveHandlerOutputSchema(schema, { choices: {} })).toBe(schema);
    });
  });

  describe("absent form", () => {
    test("returns undefined when outputSchema is undefined", () => {
      expect(resolveHandlerOutputSchema(undefined, {})).toBeUndefined();
      expect(resolveHandlerOutputSchema(undefined, { a: 1 })).toBeUndefined();
    });
  });

  describe("function form", () => {
    test("invokes the function with the step definition", () => {
      let received: Record<string, unknown> | undefined;
      const fn = (stepDef: Record<string, unknown>): TSchema => {
        received = stepDef;
        return Type.Object({ derived: Type.String() });
      };
      const stepDef = { type: "custom", choices: { a: 1 } };
      const resolved = resolveHandlerOutputSchema(fn, stepDef);
      expect(received).toEqual(stepDef);
      expect((resolved as unknown as { properties: unknown }).properties).toEqual({
        derived: Type.String(),
      });
    });

    test("returns the schema produced by the function", () => {
      const produced = Type.Object({ x: Type.Number() });
      const resolved = resolveHandlerOutputSchema(() => produced, {});
      expect(resolved).toBe(produced);
    });

    test("returns undefined when the function returns undefined", () => {
      const resolved = resolveHandlerOutputSchema(() => undefined, {});
      expect(resolved).toBeUndefined();
    });

    test("swallows a thrown error and returns undefined (defensive)", () => {
      const fn = (): TSchema => {
        throw new Error("invalid config mid-edit");
      };
      expect(() => resolveHandlerOutputSchema(fn, {})).not.toThrow();
      expect(resolveHandlerOutputSchema(fn, {})).toBeUndefined();
    });

    test("passes an empty object through when resolving a step type (no instance)", () => {
      let received: Record<string, unknown> | undefined;
      const fn = (stepDef: Record<string, unknown>): TSchema => {
        received = stepDef;
        return Type.Object({});
      };
      resolveHandlerOutputSchema(fn, {});
      expect(received).toEqual({});
    });
  });
});
