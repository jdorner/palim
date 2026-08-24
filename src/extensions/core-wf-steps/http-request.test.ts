import { describe, expect, test } from "bun:test";
import { createHttpRequestHandler } from "./http-request";

/**
 * Reads the top-level property names declared on a handler's `outputSchema`.
 *
 * The `outputSchema` is typed as `TSchema` on the handler; when it is a
 * `Type.Object(...)` it exposes a `.properties` map keyed by property name.
 *
 * @param outputSchema - The handler's declared output schema
 * @returns The sorted list of top-level property names (empty when none)
 */
function outputSchemaKeys(outputSchema: unknown): string[] {
  const properties = (outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(properties).sort();
}

describe("createHttpRequestHandler", () => {
  const handler = createHttpRequestHandler();

  describe("outputSchema", () => {
    test("declares exactly the status and body top-level properties", () => {
      expect(handler.outputSchema).toBeDefined();
      expect(outputSchemaKeys(handler.outputSchema)).toEqual(["body", "status"]);
    });
  });
});
