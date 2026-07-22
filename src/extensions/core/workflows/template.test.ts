import { beforeEach, describe, expect, test } from "bun:test";
import type { TemplateContext, TemplateSecretResolver } from "./template";
import { resolveTemplates } from "./template";

describe("resolveTemplates", () => {
  let ctx: TemplateContext;

  beforeEach(() => {
    ctx = {
      stepResults: {},
    };
  });

  describe("plain text", () => {
    test("returns template unchanged when no expressions present", async () => {
      const { resolved, warnings } = await resolveTemplates("Hello world", ctx);
      expect(resolved).toBe("Hello world");
      expect(warnings).toEqual([]);
    });

    test("returns empty string for empty input", async () => {
      const { resolved, warnings } = await resolveTemplates("", ctx);
      expect(resolved).toBe("");
      expect(warnings).toEqual([]);
    });
  });

  describe("trigger.payload", () => {
    test("resolves full trigger payload as JSON", async () => {
      ctx.triggerPayload = { foo: "bar", num: 42 };
      const { resolved } = await resolveTemplates("data: {{trigger.payload}}", ctx);
      expect(resolved).toBe('data: {"foo":"bar","num":42}');
    });

    test("resolves trigger payload string directly", async () => {
      ctx.triggerPayload = "raw-string";
      const { resolved } = await resolveTemplates("{{trigger.payload}}", ctx);
      expect(resolved).toBe("raw-string");
    });

    test("resolves dot-path into trigger payload", async () => {
      ctx.triggerPayload = { user: { name: "Alice" } };
      const { resolved } = await resolveTemplates("Hello {{trigger.payload.user.name}}", ctx);
      expect(resolved).toBe("Hello Alice");
    });

    test("warns on unresolvable path", async () => {
      ctx.triggerPayload = { user: {} };
      const { resolved, warnings } = await resolveTemplates("{{trigger.payload.user.missing}}", ctx);
      expect(resolved).toBe("{{trigger.payload.user.missing}}");
      expect(warnings).toContain("Unresolvable template path: trigger.payload.user.missing");
    });

    test("resolves null trigger payload to empty string", async () => {
      ctx.triggerPayload = null;
      const { resolved } = await resolveTemplates("{{trigger.payload}}", ctx);
      expect(resolved).toBe("");
    });
  });

  describe("steps.<slug>.result", () => {
    test("resolves full step result as string", async () => {
      ctx.stepResults = { fetch: "some output" };
      const { resolved } = await resolveTemplates("{{steps.fetch.result}}", ctx);
      expect(resolved).toBe("some output");
    });

    test("resolves full step result as JSON for objects", async () => {
      ctx.stepResults = { parse: { valid: true, count: 5 } };
      const { resolved } = await resolveTemplates("{{steps.parse.result}}", ctx);
      expect(resolved).toBe('{"valid":true,"count":5}');
    });

    test("resolves dot-path into step result", async () => {
      ctx.stepResults = { parse: { data: { title: "Test" } } };
      const { resolved } = await resolveTemplates("{{steps.parse.result.data.title}}", ctx);
      expect(resolved).toBe("Test");
    });

    test("warns on unknown step slug", async () => {
      const { resolved, warnings } = await resolveTemplates("{{steps.unknown.result}}", ctx);
      expect(resolved).toBe("{{steps.unknown.result}}");
      expect(warnings).toContain("Unknown step slug in template: unknown");
    });

    test("warns on unresolvable path within step result", async () => {
      ctx.stepResults = { fetch: { data: {} } };
      const { resolved, warnings } = await resolveTemplates("{{steps.fetch.result.data.deep.missing}}", ctx);
      expect(resolved).toBe("{{steps.fetch.result.data.deep.missing}}");
      expect(warnings).toContain("Unresolvable template path: steps.fetch.result.data.deep.missing");
    });
  });

  describe("env.<VAR>", () => {
    test("resolves allowlisted env var", async () => {
      process.env.WEB_PORT = "3000";
      const { resolved, warnings } = await resolveTemplates("port: {{env.WEB_PORT}}", ctx);
      expect(resolved).toBe("port: 3000");
      expect(warnings).toEqual([]);
    });

    test("denies access to non-allowlisted env var", async () => {
      process.env.SECRET_KEY = "hidden";
      const { resolved, warnings } = await resolveTemplates("{{env.SECRET_KEY}}", ctx);
      expect(resolved).toBe("{{env.SECRET_KEY}}");
      expect(warnings).toContain('Access denied for env var "SECRET_KEY" - not in workflow allowlist');
      delete process.env.SECRET_KEY;
    });

    test("resolves to empty string for unset allowlisted var", async () => {
      delete process.env.NODE_ENV;
      const { resolved } = await resolveTemplates("{{env.NODE_ENV}}", ctx);
      expect(resolved).toBe("");
    });
  });

  describe("secret.<KEY>", () => {
    test("resolves secret when store returns value", async () => {
      const secretStore: TemplateSecretResolver = {
        async resolve(_name, _consumer) {
          return { value: "my-token-123", granted: true };
        },
      };
      ctx.secretStore = secretStore;
      ctx.workflowName = "test-workflow";

      const { resolved, warnings } = await resolveTemplates("token={{secret.GITEA_API_TOKEN}}", ctx);
      expect(resolved).toBe("token=my-token-123");
      expect(warnings).toEqual([]);
    });

    test("passes correct consumer identity to resolver", async () => {
      let receivedConsumer = "";
      let receivedName = "";
      const secretStore: TemplateSecretResolver = {
        async resolve(name, consumer) {
          receivedName = name;
          receivedConsumer = consumer;
          return { value: "val", granted: true };
        },
      };
      ctx.secretStore = secretStore;
      ctx.workflowName = "my-wf";

      await resolveTemplates("{{secret.API_KEY}}", ctx);
      expect(receivedName).toBe("API_KEY");
      expect(receivedConsumer).toBe("workflow:my-wf");
    });

    test("warns when secret store is not available", async () => {
      ctx.workflowName = "test";
      const { resolved, warnings } = await resolveTemplates("{{secret.TOKEN}}", ctx);
      expect(resolved).toBe("{{secret.TOKEN}}");
      expect(warnings).toContain("Secret store not available for template: secret.TOKEN");
    });

    test("warns when workflow name is not set", async () => {
      ctx.secretStore = {
        async resolve() {
          return { value: "x", granted: true };
        },
      };
      const { resolved, warnings } = await resolveTemplates("{{secret.TOKEN}}", ctx);
      expect(resolved).toBe("{{secret.TOKEN}}");
      expect(warnings).toContain("Workflow name not set for secret resolution: secret.TOKEN");
    });

    test("warns when access is denied", async () => {
      ctx.secretStore = {
        async resolve() {
          return { value: null, granted: false, reason: "not in ACL" };
        },
      };
      ctx.workflowName = "denied-wf";

      const { resolved, warnings } = await resolveTemplates("{{secret.PRIVATE}}", ctx);
      expect(resolved).toBe("{{secret.PRIVATE}}");
      expect(warnings).toContain('Access denied for secret "PRIVATE": not in ACL');
    });

    test("warns when secret is not found (granted but null value)", async () => {
      ctx.secretStore = {
        async resolve() {
          return { value: null, granted: true };
        },
      };
      ctx.workflowName = "test-wf";

      const { resolved, warnings } = await resolveTemplates("{{secret.MISSING}}", ctx);
      expect(resolved).toBe("{{secret.MISSING}}");
      expect(warnings).toContain('Secret "MISSING" not found');
    });

    test("does not resolve to 'undefined' when resolver is async", async () => {
      // Regression: if the resolver's Promise is not awaited, result.value
      // would be undefined (accessing .value on a Promise object).
      const secretStore: TemplateSecretResolver = {
        resolve(_name, _consumer) {
          return Promise.resolve({ value: "async-secret-val", granted: true });
        },
      };
      ctx.secretStore = secretStore;
      ctx.workflowName = "secret-test";

      const { resolved, warnings } = await resolveTemplates("token={{secret.GITEA_API_TOKEN}}", ctx);
      expect(resolved).toBe("token=async-secret-val");
      expect(resolved).not.toContain("undefined");
      expect(warnings).toEqual([]);
    });
  });

  describe("multiple expressions", () => {
    test("resolves multiple expressions in one template", async () => {
      ctx.triggerPayload = { action: "push" };
      ctx.stepResults = { build: "success" };
      process.env.WEB_PORT = "3000";

      const template = "Action: {{trigger.payload.action}}, Build: {{steps.build.result}}, Port: {{env.WEB_PORT}}";
      const { resolved, warnings } = await resolveTemplates(template, ctx);
      expect(resolved).toBe("Action: push, Build: success, Port: 3000");
      expect(warnings).toEqual([]);
    });

    test("handles mix of resolvable and unresolvable expressions", async () => {
      ctx.triggerPayload = { ok: true };
      const template = "{{trigger.payload.ok}} and {{trigger.payload.missing}}";
      const { resolved, warnings } = await resolveTemplates(template, ctx);
      expect(resolved).toBe("true and {{trigger.payload.missing}}");
      expect(warnings.length).toBe(1);
    });
  });

  describe("edge cases", () => {
    test("warns on unrecognized expression", async () => {
      const { resolved, warnings } = await resolveTemplates("{{unknown.thing}}", ctx);
      expect(resolved).toBe("{{unknown.thing}}");
      expect(warnings).toContain("Unrecognized template expression: unknown.thing");
    });

    test("handles whitespace in expressions", async () => {
      ctx.triggerPayload = "hello";
      const { resolved } = await resolveTemplates("{{ trigger.payload }}", ctx);
      expect(resolved).toBe("hello");
    });

    test("preserves text around expressions", async () => {
      ctx.stepResults = { s1: "val" };
      const { resolved } = await resolveTemplates("before {{steps.s1.result}} after", ctx);
      expect(resolved).toBe("before val after");
    });
  });

  describe("steps.<slug>.config", () => {
    test("resolves full step config as JSON", async () => {
      ctx.stepConfigs = {
        "excel-step": {
          slug: "excel-step",
          type: "excel",
          mode: "create",
          columns: [{ header: "Name", key: "name" }],
        },
      };
      const { resolved, warnings } = await resolveTemplates("config: {{steps.excel-step.config}}", ctx);
      expect(resolved).toContain('"mode":"create"');
      expect(resolved).toContain('"columns"');
      expect(warnings).toEqual([]);
    });

    test("resolves dot-path into step config", async () => {
      ctx.stepConfigs = {
        "append-row": {
          slug: "append-row",
          type: "excel",
          sheets: [
            {
              name: "Sales",
              columns: [
                { header: "Product", key: "product" },
                { header: "Revenue", key: "revenue", numFmt: "$#,##0.00" },
              ],
            },
          ],
        },
      };
      const { resolved, warnings } = await resolveTemplates("{{steps.append-row.config.sheets}}", ctx);
      const parsed = JSON.parse(resolved);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].columns).toHaveLength(2);
      expect(parsed[0].columns[0].key).toBe("product");
      expect(warnings).toEqual([]);
    });

    test("resolves deeply nested config path", async () => {
      ctx.stepConfigs = {
        "my-step": {
          sheets: [{ name: "Sheet1", columns: [{ header: "A", key: "a" }] }],
        },
      };
      const { resolved } = await resolveTemplates("{{steps.my-step.config.sheets.0.columns.0.key}}", ctx);
      expect(resolved).toBe("a");
    });

    test("warns on unknown step slug in config template", async () => {
      ctx.stepConfigs = {};
      const { resolved, warnings } = await resolveTemplates("{{steps.nonexistent.config}}", ctx);
      expect(resolved).toBe("{{steps.nonexistent.config}}");
      expect(warnings).toContain("Unknown step slug in config template: nonexistent");
    });

    test("warns on unresolvable path within step config", async () => {
      ctx.stepConfigs = { "my-step": { mode: "create" } };
      const { resolved, warnings } = await resolveTemplates("{{steps.my-step.config.missing.field}}", ctx);
      expect(resolved).toBe("{{steps.my-step.config.missing.field}}");
      expect(warnings).toContain("Unresolvable template path: steps.my-step.config.missing.field");
    });

    test("works without stepConfigs (returns warning for any config reference)", async () => {
      // stepConfigs not set
      const { resolved, warnings } = await resolveTemplates("{{steps.any.config}}", ctx);
      expect(resolved).toBe("{{steps.any.config}}");
      expect(warnings).toContain("Unknown step slug in config template: any");
    });

    test("config and result can be used together", async () => {
      ctx.stepResults = { extract: "extracted-data" };
      ctx.stepConfigs = {
        "excel-step": { columns: [{ header: "Name", key: "name" }] },
      };
      const template = "Data: {{steps.extract.result}}, Schema: {{steps.excel-step.config.columns}}";
      const { resolved, warnings } = await resolveTemplates(template, ctx);
      expect(resolved).toContain("Data: extracted-data");
      expect(resolved).toContain('"key":"name"');
      expect(warnings).toEqual([]);
    });
  });
});
