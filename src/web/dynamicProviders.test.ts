import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearDynamicProviders,
  enrichSchema,
  registerDynamicDefaultProvider,
  registerDynamicItemProvider,
  resolveDynamicDefault,
  resolveDynamicItems,
} from "./dynamicProviders";

describe("dynamicProviders", () => {
  beforeEach(() => {
    clearDynamicProviders();
  });

  describe("registerDynamicItemProvider", () => {
    test("registers a provider that can be resolved", () => {
      registerDynamicItemProvider("queues", () => ["agents", "chat"]);
      const result = resolveDynamicItems("queues");
      expect(result).toEqual(["agents", "chat"]);
    });

    test("replaces an existing provider with the same name", () => {
      registerDynamicItemProvider("queues", () => ["agents"]);
      registerDynamicItemProvider("queues", () => ["agents", "chat", "workflows:steps"]);
      const result = resolveDynamicItems("queues");
      expect(result).toEqual(["agents", "chat", "workflows:steps"]);
    });
  });

  describe("resolveDynamicItems", () => {
    test("returns null for an unregistered provider", () => {
      const result = resolveDynamicItems("nonexistent");
      expect(result).toBeNull();
    });

    test("returns null when the provider throws an error", () => {
      registerDynamicItemProvider("broken", () => {
        throw new Error("provider failure");
      });
      const result = resolveDynamicItems("broken");
      expect(result).toBeNull();
    });

    test("returns the current items from the provider each time", () => {
      let items = ["a"];
      registerDynamicItemProvider("dynamic", () => items);

      expect(resolveDynamicItems("dynamic")).toEqual(["a"]);

      items = ["a", "b", "c"];
      expect(resolveDynamicItems("dynamic")).toEqual(["a", "b", "c"]);
    });
  });

  describe("enrichSchema - dynamicItems", () => {
    test("returns the original schema when no properties have dynamicItems", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
          count: { type: "number", title: "Count" },
        },
      };

      const result = enrichSchema(schema);
      // Should return the same reference (no clone needed)
      expect(result).toBe(schema);
    });

    test("enriches availableItems from a registered provider", () => {
      registerDynamicItemProvider("all-queue-names", () => ["agents", "chat", "workflows", "error-analyzer:analysis"]);

      const schema = {
        type: "object",
        properties: {
          monitoredQueues: {
            type: "array",
            title: "Monitored Queues",
            availableItems: ["agents", "chat", "workflows"],
            dynamicItems: "all-queue-names",
          },
        },
      };

      const result = enrichSchema(schema);
      const prop = (result.properties as Record<string, Record<string, unknown>>).monitoredQueues;
      expect(prop?.availableItems).toEqual(["agents", "chat", "workflows", "error-analyzer:analysis"]);
    });

    test("does not mutate the original schema", () => {
      registerDynamicItemProvider("test-provider", () => ["x", "y"]);

      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            availableItems: ["a"],
            dynamicItems: "test-provider",
          },
        },
      };

      enrichSchema(schema);
      const prop = (schema.properties as Record<string, Record<string, unknown>>).items;
      expect(prop?.availableItems).toEqual(["a"]);
    });

    test("preserves static availableItems when provider is not registered", () => {
      const schema = {
        type: "object",
        properties: {
          queues: {
            type: "array",
            availableItems: ["agents", "chat"],
            dynamicItems: "missing-provider",
          },
        },
      };

      const result = enrichSchema(schema);
      const prop = (result.properties as Record<string, Record<string, unknown>>).queues;
      expect(prop?.availableItems).toEqual(["agents", "chat"]);
    });

    test("preserves static availableItems when provider throws", () => {
      registerDynamicItemProvider("failing", () => {
        throw new Error("boom");
      });

      const schema = {
        type: "object",
        properties: {
          queues: {
            type: "array",
            availableItems: ["fallback"],
            dynamicItems: "failing",
          },
        },
      };

      const result = enrichSchema(schema);
      const prop = (result.properties as Record<string, Record<string, unknown>>).queues;
      expect(prop?.availableItems).toEqual(["fallback"]);
    });

    test("only enriches properties that declare dynamicItems", () => {
      registerDynamicItemProvider("colors", () => ["red", "blue"]);

      const schema = {
        type: "object",
        properties: {
          colors: {
            type: "array",
            availableItems: ["green"],
            dynamicItems: "colors",
          },
          staticField: {
            type: "array",
            availableItems: ["static1", "static2"],
          },
        },
      };

      const result = enrichSchema(schema);
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props.colors?.availableItems).toEqual(["red", "blue"]);
      expect(props.staticField?.availableItems).toEqual(["static1", "static2"]);
    });

    test("returns schema unchanged when properties is undefined", () => {
      const schema = { type: "object" };
      const result = enrichSchema(schema);
      expect(result).toBe(schema);
    });
  });

  describe("registerDynamicDefaultProvider / resolveDynamicDefault", () => {
    test("registers a default provider that can be resolved", () => {
      registerDynamicDefaultProvider("fpcalc", () => "/usr/bin/fpcalc");
      expect(resolveDynamicDefault("fpcalc")).toBe("/usr/bin/fpcalc");
    });

    test("returns null for an unregistered default provider", () => {
      expect(resolveDynamicDefault("nope")).toBeNull();
    });

    test("returns null when the default provider throws", () => {
      registerDynamicDefaultProvider("broken", () => {
        throw new Error("boom");
      });
      expect(resolveDynamicDefault("broken")).toBeNull();
    });

    test("reflects the current value each call", () => {
      let p = "/a";
      registerDynamicDefaultProvider("dyn", () => p);
      expect(resolveDynamicDefault("dyn")).toBe("/a");
      p = "/b";
      expect(resolveDynamicDefault("dyn")).toBe("/b");
    });
  });

  describe("enrichSchema - dynamicDefault", () => {
    test("resolves a scalar default from a registered provider", () => {
      registerDynamicDefaultProvider("fpcalc-discovered", () => "/usr/bin/fpcalc");

      const schema = {
        type: "object",
        properties: {
          fpcalcPath: { type: "string", title: "fpcalc Path", default: "", dynamicDefault: "fpcalc-discovered" },
        },
      };

      const result = enrichSchema(schema);
      const prop = (result.properties as Record<string, Record<string, unknown>>).fpcalcPath;
      expect(prop?.default).toBe("/usr/bin/fpcalc");
    });

    test("leaves the static default untouched when the provider returns empty", () => {
      registerDynamicDefaultProvider("empty", () => "");

      const schema = {
        type: "object",
        properties: {
          fpcalcPath: { type: "string", default: "static-fallback", dynamicDefault: "empty" },
        },
      };

      const result = enrichSchema(schema);
      const prop = (result.properties as Record<string, Record<string, unknown>>).fpcalcPath;
      expect(prop?.default).toBe("static-fallback");
    });

    test("leaves the static default untouched when the provider is missing", () => {
      const schema = {
        type: "object",
        properties: {
          fpcalcPath: { type: "string", default: "static", dynamicDefault: "not-registered" },
        },
      };

      const result = enrichSchema(schema);
      const prop = (result.properties as Record<string, Record<string, unknown>>).fpcalcPath;
      expect(prop?.default).toBe("static");
    });

    test("does not mutate the original schema", () => {
      registerDynamicDefaultProvider("disc", () => "/resolved");
      const schema = {
        type: "object",
        properties: {
          fpcalcPath: { type: "string", default: "", dynamicDefault: "disc" },
        },
      };

      enrichSchema(schema);
      const prop = (schema.properties as Record<string, Record<string, unknown>>).fpcalcPath;
      expect(prop?.default).toBe("");
    });
  });

  describe("clearDynamicProviders", () => {
    test("removes all registered providers (items and defaults)", () => {
      registerDynamicItemProvider("a", () => ["1"]);
      registerDynamicItemProvider("b", () => ["2"]);
      registerDynamicDefaultProvider("d", () => "/x");

      clearDynamicProviders();

      expect(resolveDynamicItems("a")).toBeNull();
      expect(resolveDynamicItems("b")).toBeNull();
      expect(resolveDynamicDefault("d")).toBeNull();
    });
  });
});
