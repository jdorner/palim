import { beforeEach, describe, expect, test } from "bun:test";
import type { TemplateVariableResolver } from "@src/variables";
import fc from "fast-check";
import type { TemplateContext, TemplateSecretResolver } from "./template";
import { resolveTemplates } from "./template";

/**
 * In-memory fake implementing {@link TemplateVariableResolver}, backed by a Map.
 *
 * Used to exercise the {{var.KEY}} branch of the template engine without a
 * database. Mirrors the plaintext, no-ACL semantics of the real VariableStore.
 */
class FakeVariableResolver implements TemplateVariableResolver {
  private store: Map<string, string>;

  /**
   * @param entries - Initial key/value pairs to seed the resolver with.
   */
  constructor(entries: Map<string, string> = new Map()) {
    this.store = entries;
  }

  /**
   * @param key - The variable key.
   * @returns The stored plaintext value, or null when the key is absent.
   */
  resolve(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  /**
   * @param key - The variable key.
   * @returns True when the key exists in the map.
   */
  has(key: string): boolean {
    return this.store.has(key);
  }
}

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

  describe("var.<KEY>", () => {
    test("substitutes an existing variable with its plaintext value", async () => {
      ctx.variableStore = new FakeVariableResolver(new Map([["API_BASE_URL", "https://example.com"]]));
      const { resolved, warnings } = await resolveTemplates("url={{var.API_BASE_URL}}", ctx);
      expect(resolved).toBe("url=https://example.com");
      expect(warnings).toEqual([]);
    });

    test("leaves literal and warns when the key does not exist", async () => {
      ctx.variableStore = new FakeVariableResolver();
      const { resolved, warnings } = await resolveTemplates("{{var.MISSING}}", ctx);
      expect(resolved).toBe("{{var.MISSING}}");
      expect(warnings).toContain('Variable "MISSING" not found');
    });

    test("leaves literal and warns when no variable store is provided", async () => {
      const { resolved, warnings } = await resolveTemplates("{{var.ANY}}", ctx);
      expect(resolved).toBe("{{var.ANY}}");
      expect(warnings).toContain("Variable store not available for template: var.ANY");
    });

    test("substitutes value byte-for-byte with no transformation", async () => {
      const raw = '  spaced\n{"json":true}\ttrailing  ';
      ctx.variableStore = new FakeVariableResolver(new Map([["RAW", raw]]));
      const { resolved, warnings } = await resolveTemplates("{{var.RAW}}", ctx);
      expect(resolved).toBe(raw);
      expect(warnings).toEqual([]);
    });

    test("malformed var expression (wrong segment count) falls through to unrecognized handling", async () => {
      ctx.variableStore = new FakeVariableResolver(new Map([["A", "x"]]));
      const { resolved, warnings } = await resolveTemplates("{{var.A.B}}", ctx);
      expect(resolved).toBe("{{var.A.B}}");
      expect(warnings).toContain("Unrecognized template expression: var.A.B");
    });
  });

  // ---------------------------------------------------------------------------
  // Property-based tests for the {{var.KEY}} namespace.
  // ---------------------------------------------------------------------------

  // Generator for valid variable keys matching the documented format
  // ^[A-Z][A-Z0-9_]{0,63}$ (upper snake case).
  const varKeyArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/).filter((s) => /^[A-Z][A-Z0-9_]{0,63}$/.test(s));

  // Arbitrary plaintext values (may contain arbitrary unicode; the engine must
  // emit them byte-for-byte with no transformation).
  const varValueArb = fc.string();

  // Feature: global-variables, Property 6
  test("Property 6: substitution replaces matches and preserves the rest", async () => {
    // Validates: Requirements 5.1, 5.2, 5.3, 5.4
    await fc.assert(
      fc.asyncProperty(
        // A map of stored variables.
        fc.dictionary(varKeyArb, varValueArb),
        // 1..100 keys to reference (all guaranteed to exist since drawn from the map).
        fc.array(fc.nat(), { minLength: 1, maxLength: 100 }),
        // Literal surrounding chunks that never contain braces, so they cannot
        // interfere with {{...}} delimiter parsing at chunk boundaries.
        fc.array(
          fc.string().map((s) => s.replace(/[{}]/g, "")),
          { minLength: 1 },
        ),
        async (varsRecord, refIndexes, chunks) => {
          const keys = Object.keys(varsRecord);
          fc.pre(keys.length > 0);

          const store = new Map(Object.entries(varsRecord));
          const ctxLocal: TemplateContext = { stepResults: {}, variableStore: new FakeVariableResolver(store) };

          // Interleave literal chunks with {{var.KEY}} references so every
          // reference resolves to an existing key.
          const usedKeys = refIndexes.map((i) => keys[i % keys.length]!);
          let field = "";
          let expected = "";
          for (let i = 0; i < usedKeys.length; i++) {
            const chunk = chunks[i % chunks.length]!;
            field += `${chunk}{{var.${usedKeys[i]!}}}`;
            expected += `${chunk}${store.get(usedKeys[i]!)!}`;
          }
          const tail = chunks[usedKeys.length % chunks.length]!;
          field += tail;
          expected += tail;

          const { resolved, warnings } = await resolveTemplates(field, ctxLocal);
          expect(resolved).toBe(expected);
          expect(warnings).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: global-variables, Property 7
  test("Property 7: misses stay literal and warn once per distinct reference", async () => {
    // Validates: Requirement 5.5
    await fc.assert(
      fc.asyncProperty(
        // Existing variables in the store.
        fc.dictionary(varKeyArb, varValueArb),
        // Distinct keys that are guaranteed NOT to exist (prefixed to avoid collisions).
        fc.uniqueArray(varKeyArb, { minLength: 1, maxLength: 20 }),
        async (existingRecord, missingKeysRaw) => {
          const store = new Map(Object.entries(existingRecord));
          // Ensure "missing" keys truly do not exist in the store.
          const missingKeys = missingKeysRaw.filter((k) => !store.has(k));
          fc.pre(missingKeys.length > 0);

          const ctxLocal: TemplateContext = { stepResults: {}, variableStore: new FakeVariableResolver(store) };

          const existingKeys = Object.keys(existingRecord);

          // Build a field that references each missing key (possibly repeated)
          // plus, when available, one existing key that must still resolve.
          let field = "";
          let expectedContainsExisting: string | undefined;
          if (existingKeys.length > 0) {
            const k = existingKeys[0]!;
            field += `prefix {{var.${k}}} `;
            expectedContainsExisting = store.get(k)!;
          }
          // Reference each distinct missing key exactly once.
          for (const k of missingKeys) {
            field += `{{var.${k}}} `;
          }

          const { resolved, warnings } = await resolveTemplates(field, ctxLocal);
          // Each missing reference stays literal in the output.
          for (const k of missingKeys) {
            expect(resolved).toContain(`{{var.${k}}}`);
          }
          // The existing-key expression is still substituted (no warning for it).
          if (expectedContainsExisting !== undefined) {
            const k = existingKeys[0]!;
            expect(warnings).not.toContain(`Variable "${k}" not found`);
            // The literal placeholder was consumed (unless the value itself
            // reproduces the placeholder text, which we tolerate).
            if (!expectedContainsExisting.includes(`{{var.${k}}}`)) {
              expect(resolved).not.toContain(`{{var.${k}}}`);
            }
          }
          // Exactly one warning per distinct unresolved reference.
          for (const k of missingKeys) {
            const warningText = `Variable "${k}" not found`;
            const count = warnings.filter((w) => w === warningText).length;
            expect(count).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Expression evaluation (function calls / composed transforms)
  // ---------------------------------------------------------------------------

  describe("expression evaluation", () => {
    test("evaluates a function call over the iterator item", async () => {
      ctx.iterationContext = { item: { dataUrl: "data:image/jpeg;base64,ABC123" }, itemIndex: 0, as: "image" };
      const { resolved, warnings } = await resolveTemplates("{{ stripDataUri(image.dataUrl) }}", ctx);
      expect(resolved).toBe("ABC123");
      expect(warnings).toEqual([]);
    });

    test("evaluates nested function calls and preserves surrounding text", async () => {
      ctx.iterationContext = { item: { dataUrl: 'data:text/plain;base64,QUJD"' }, itemIndex: 0, as: "image" };
      const { resolved, warnings } = await resolveTemplates(
        'body {"data": "{{ jsonEscape(stripDataUri(image.dataUrl)) }}"} end',
        ctx,
      );
      expect(resolved).toBe('body {"data": "QUJD\\""} end');
      expect(warnings).toEqual([]);
      // The embedded JSON object is valid after escaping.
      const jsonPart = resolved.slice(resolved.indexOf("{"), resolved.lastIndexOf("}") + 1);
      expect((JSON.parse(jsonPart) as { data: string }).data).toBe('QUJD"');
    });

    test("evaluates a function over a step result", async () => {
      ctx.stepResults = { fetch: { url: "key=value" } };
      const { resolved } = await resolveTemplates("{{ after(steps.fetch.result.url, '=') }}", ctx);
      expect(resolved).toBe("value");
    });

    test("unknown function leaves the expression literal and warns", async () => {
      const { resolved, warnings } = await resolveTemplates("{{ notAFunction(x) }}", ctx);
      // The literal fallback re-emits the trimmed expression.
      expect(resolved).toBe("{{notAFunction(x)}}");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("notAFunction(x)");
    });

    test("parse error leaves the expression literal and warns", async () => {
      const { resolved, warnings } = await resolveTemplates("{{ stripDataUri( }}", ctx);
      expect(resolved).toBe("{{stripDataUri(}}");
      expect(warnings.length).toBe(1);
    });

    describe("sandbox", () => {
      test("constructor escape does not return host process and is left literal + warned", async () => {
        const hostProcess = (globalThis as { process?: unknown }).process;
        const { resolved, warnings } = await resolveTemplates('{{ constructor.constructor("return process")() }}', ctx);
        // Left literal (not substituted with the host process JSON) and warned.
        expect(resolved).toContain("{{");
        expect(resolved).not.toContain(String((hostProcess as { pid?: number })?.pid ?? "NO_PID_MATCH"));
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("Forbidden key");
      });

      test("dunder/prototype member access is left literal + warned", async () => {
        ctx.iterationContext = { item: { a: 1 }, itemIndex: 0, as: "image" };
        const { resolved, warnings } = await resolveTemplates("{{ image.__proto__ }}", ctx);
        expect(resolved).toBe("{{image.__proto__}}");
        expect(warnings[0]).toContain("Forbidden key");
      });

      test("secret values are not reachable from expression logic", async () => {
        // secret is resolved by its own branch, never exposed to the evaluator.
        // A function call that tries to reference `secret` sees no such scope key.
        ctx.secretStore = {
          async resolve() {
            return { value: "TOP_SECRET", granted: true };
          },
        };
        ctx.workflowName = "wf";
        const { resolved } = await resolveTemplates("{{ trim(secret.API_KEY) }}", ctx);
        // `secret` is undefined in the eval scope -> trim(undefined) -> "".
        expect(resolved).not.toContain("TOP_SECRET");
      });
    });
  });
});
