import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "./schemas";
import type { TemplateSecretResolver } from "./template";
import { resetEnvAllowlistCache, validateWorkflowTemplates } from "./templateValidation";

/** Helper to build a minimal valid workflow definition. */
function makeWorkflow(steps: WorkflowDefinition["steps"]): WorkflowDefinition {
  return {
    name: "test-workflow",
    trigger: { type: "manual" },
    steps,
  };
}

/** Fake secret resolver for testing. */
function fakeSecretStore(secrets: Record<string, string>): TemplateSecretResolver {
  return {
    async resolve(name: string, _consumer: string) {
      if (name in secrets) {
        return { value: secrets[name]!, granted: true };
      }
      return { value: null, granted: true };
    },
  };
}

/** Fake secret resolver that denies access. */
function denyingSecretStore(): TemplateSecretResolver {
  return {
    async resolve(_name: string, _consumer: string) {
      return { value: null, granted: false, reason: "ACL denied" };
    },
  };
}

describe("validateWorkflowTemplates", () => {
  beforeEach(() => {
    resetEnvAllowlistCache();
  });

  describe("valid workflows", () => {
    test("returns no warnings for a workflow with no templates", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Do something" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });

    test("returns no warnings for valid trigger.payload reference", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Process: {{trigger.payload}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });

    test("returns no warnings for valid trigger.payload.field path", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Name: {{trigger.payload.user.name}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });

    test("returns no warnings for valid step result reference", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Do A" },
        { slug: "step-b", type: "agent", prompt: "Continue with: {{steps.step-a.result}}" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });

    test("returns no warnings for valid step result with dot path", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Do A" },
        { slug: "step-b", type: "agent", prompt: "Use: {{steps.step-a.result.summary}}" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });

    test("returns no warnings for allowed env vars", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Host: {{env.WEB_HOST}}:{{env.WEB_PORT}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });

    test("returns no warnings for valid secret expression without store", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Key: {{secret.API_KEY}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });

    test("returns no warnings for valid secret expression with store that has the key", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Key: {{secret.API_KEY}}" }]);
      const store = fakeSecretStore({ API_KEY: "sk-123" });
      const warnings = await validateWorkflowTemplates(def, {
        secretStore: store,
        workflowName: "test-workflow",
      });
      expect(warnings).toEqual([]);
    });

    test("returns no warnings for webhook step with valid templates", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Analyze" },
        {
          slug: "notify",
          type: "webhook",
          url: "https://hooks.example.com/{{env.WEB_HOST}}",
          body: '{"result": "{{steps.step-a.result}}"}',
        },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });

    test("handles multiple valid templates in a single field", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Do A" },
        {
          slug: "step-b",
          type: "agent",
          prompt: "Host {{env.WEB_HOST}}, result {{steps.step-a.result}}, trigger {{trigger.payload}}",
        },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });
  });

  describe("unknown step slug references", () => {
    test("warns when referencing a non-existent step slug", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Use: {{steps.nonexistent.result}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([
        {
          stepSlug: "step-a",
          field: "prompt",
          message: 'References unknown step slug "nonexistent" in "{{steps.nonexistent.result}}"',
        },
      ]);
    });

    test("warns for typo in step slug", async () => {
      const def = makeWorkflow([
        { slug: "analyze", type: "agent", prompt: "Do analysis" },
        { slug: "report", type: "agent", prompt: "Report on: {{steps.analize.result}}" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('unknown step slug "analize"');
    });
  });

  describe("forward references (self-referencing prevention)", () => {
    test("warns when a step references itself", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Self: {{steps.step-a.result}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('Forward reference to step "step-a"');
    });

    test("warns when a step references a later step", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Future: {{steps.step-b.result}}" },
        { slug: "step-b", type: "agent", prompt: "Do B" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.stepSlug).toBe("step-a");
      expect(warnings[0]!.message).toContain('Forward reference to step "step-b"');
      expect(warnings[0]!.message).toContain("can only reference earlier steps");
    });

    test("allows referencing an earlier step but not a later one", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Do A" },
        { slug: "step-b", type: "agent", prompt: "Use A: {{steps.step-a.result}}, Use C: {{steps.step-c.result}}" },
        { slug: "step-c", type: "agent", prompt: "Do C" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('Forward reference to step "step-c"');
    });

    test("allows config references to later steps (config is static)", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Schema: {{steps.step-b.config.columns}}" },
        { slug: "step-b", type: "agent", prompt: "Do B" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(0);
    });

    test("allows config reference to self", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "My config: {{steps.step-a.config}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(0);
    });
  });

  describe("expression syntax validation", () => {
    test("warns for unknown prefix", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Value: {{unknown.something}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('Unknown expression prefix "unknown"');
    });

    test("warns for incomplete steps expression", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Bad: {{steps.}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain("Incomplete steps expression");
    });

    test("warns for steps expression with only slug (no accessor)", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Do A" },
        { slug: "step-b", type: "agent", prompt: "Bad: {{steps.step-a}}" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain("Incomplete steps expression");
    });

    test("warns for invalid step accessor (not result)", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Do A" },
        { slug: "step-b", type: "agent", prompt: "Bad: {{steps.step-a.output}}" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('Invalid step accessor "output"');
      expect(warnings[0]!.message).toContain('only "result" and "config" are supported');
    });

    test("warns for invalid trigger expression (missing payload)", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Bad: {{trigger.data}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain("Invalid trigger expression");
      expect(warnings[0]!.message).toContain("expected");
    });

    test("warns for trigger expression with only prefix", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Bad: {{trigger}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain("Invalid trigger expression");
    });

    test("warns for incomplete env expression", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Bad: {{env}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain("Incomplete env expression");
    });

    test("warns for invalid secret expression with path segments", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Bad: {{secret.KEY.sub}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain("Invalid secret expression");
    });

    test("warns for empty secret key", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Bad: {{secret.}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain("Invalid secret expression");
    });
  });

  describe("env allowlist checks", () => {
    test("warns for env var not in allowlist", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Key: {{env.OPENAI_API_KEY}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('"OPENAI_API_KEY" is not in the workflow allowlist');
    });

    test("allows WORKFLOW_ENV_ALLOWLIST additions", async () => {
      process.env.WORKFLOW_ENV_ALLOWLIST = "CUSTOM_VAR,ANOTHER_VAR";
      resetEnvAllowlistCache();

      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Val: {{env.CUSTOM_VAR}} and {{env.ANOTHER_VAR}}" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);

      delete process.env.WORKFLOW_ENV_ALLOWLIST;
    });

    test("still rejects non-allowlisted vars even with additions", async () => {
      process.env.WORKFLOW_ENV_ALLOWLIST = "CUSTOM_VAR";
      resetEnvAllowlistCache();

      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Bad: {{env.SECRET_KEY}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('"SECRET_KEY" is not in the workflow allowlist');

      delete process.env.WORKFLOW_ENV_ALLOWLIST;
    });
  });

  describe("secret key validation with store", () => {
    test("warns when secret key is not found in vault", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Key: {{secret.MISSING_KEY}}" }]);
      const store = fakeSecretStore({});
      const warnings = await validateWorkflowTemplates(def, {
        secretStore: store,
        workflowName: "test-workflow",
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('"MISSING_KEY" not found in vault');
    });

    test("warns when secret access is denied", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Key: {{secret.PRIVATE_KEY}}" }]);
      const store = denyingSecretStore();
      const warnings = await validateWorkflowTemplates(def, {
        secretStore: store,
        workflowName: "test-workflow",
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('"PRIVATE_KEY" access denied');
      expect(warnings[0]!.message).toContain("ACL denied");
    });

    test("skips secret validation when no store is provided", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Key: {{secret.ANY_KEY}}" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });

    test("skips secret validation when no workflowName is provided", async () => {
      const def = makeWorkflow([{ slug: "step-a", type: "agent", prompt: "Key: {{secret.ANY_KEY}}" }]);
      const store = fakeSecretStore({});
      const warnings = await validateWorkflowTemplates(def, { secretStore: store });
      expect(warnings).toEqual([]);
    });
  });

  describe("webhook step fields", () => {
    test("validates templates in url field", async () => {
      const def = makeWorkflow([
        { slug: "notify", type: "webhook", url: "https://api.example.com/{{steps.missing.result}}" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.field).toBe("url");
      expect(warnings[0]!.message).toContain('unknown step slug "missing"');
    });

    test("validates templates in body field", async () => {
      const def = makeWorkflow([
        { slug: "notify", type: "webhook", url: "https://api.example.com/hook", body: "{{unknown.prefix}}" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.field).toBe("body");
      expect(warnings[0]!.message).toContain('Unknown expression prefix "unknown"');
    });

    test("does not validate webhook step without body", async () => {
      const def = makeWorkflow([{ slug: "notify", type: "webhook", url: "https://api.example.com/hook" }]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });
  });

  describe("multiple warnings", () => {
    test("reports all issues across multiple steps and fields", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Bad: {{unknown.x}} and {{env.SECRET}}" },
        { slug: "step-b", type: "agent", prompt: "Forward: {{steps.step-c.result}}" },
        { slug: "step-c", type: "agent", prompt: "Self: {{steps.step-c.result}}" },
      ]);
      const warnings = await validateWorkflowTemplates(def);
      expect(warnings.length).toBe(4);
    });

    test("deduplicates identical expressions within the same field", async () => {
      const def = makeWorkflow([
        { slug: "step-a", type: "agent", prompt: "Use {{secret.TOKEN}} and again {{secret.TOKEN}}" },
      ]);
      const store = fakeSecretStore({});
      const warnings = await validateWorkflowTemplates(def, {
        secretStore: store,
        workflowName: "test-workflow",
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('"TOKEN" not found in vault');
    });
  });
});
