import { describe, expect, test } from "bun:test";
import { type FlatGraph, flattenWorkflow, type StepData, unflattenWorkflow } from "./workflowGraph";

describe("flattenWorkflow", () => {
  describe("linear workflows", () => {
    test("single agent step produces one node and no edges", () => {
      const steps: StepData[] = [{ slug: "greet", type: "agent", prompt: "Hello" }];
      const graph = flattenWorkflow(steps);

      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0].id).toBe("step-0");
      expect(graph.nodes[0].data).toEqual({ slug: "greet", type: "agent", prompt: "Hello" });
      expect(graph.nodes[0].parent).toBeNull();
      expect(graph.edges).toHaveLength(0);
    });

    test("multiple sequential steps are connected with edges", () => {
      const steps: StepData[] = [
        { slug: "fetch", type: "agent", prompt: "Fetch data" },
        { slug: "process", type: "agent", prompt: "Process data" },
        { slug: "notify", type: "agent", prompt: "Notify user" },
      ];
      const graph = flattenWorkflow(steps);

      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges).toHaveLength(2);
      expect(graph.edges[0]).toEqual({
        id: "step-0->step-1",
        source: "step-0",
        target: "step-1",
      });
      expect(graph.edges[1]).toEqual({
        id: "step-1->step-2",
        source: "step-1",
        target: "step-2",
      });
    });

    test("waitFor and emit steps are treated as regular nodes", () => {
      const steps: StepData[] = [
        { slug: "wait", type: "waitFor", event: "approval" },
        { slug: "signal", type: "emit", event: "done", payload: "ok" },
      ];
      const graph = flattenWorkflow(steps);

      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes[0].data).toEqual({ slug: "wait", type: "waitFor", event: "approval" });
      expect(graph.nodes[1].data).toEqual({ slug: "signal", type: "emit", event: "done", payload: "ok" });
      expect(graph.edges).toHaveLength(1);
    });

    test("generic extension steps preserve extra properties", () => {
      const steps: StepData[] = [{ slug: "request", type: "http-request", url: "https://example.com", method: "GET" }];
      const graph = flattenWorkflow(steps);

      expect(graph.nodes[0].data).toEqual({
        slug: "request",
        type: "http-request",
        url: "https://example.com",
        method: "GET",
      });
    });
  });

  describe("if nodes", () => {
    test("if with then branch creates branch nodes and labeled edge", () => {
      const steps: StepData[] = [
        {
          slug: "check",
          type: "if",
          condition: { ref: "{{trigger.status}}", eq: "ok" },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [{ slug: "success", type: "agent", prompt: "It worked" }],
        },
      ];
      const graph = flattenWorkflow(steps);

      // Nodes: the if node + the then-branch step
      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes[0].id).toBe("step-0");
      expect(graph.nodes[0].data.type).toBe("if");
      // Branch arrays should be stripped from node data
      expect(graph.nodes[0].data).not.toHaveProperty("then");
      expect(graph.nodes[0].data).not.toHaveProperty("else");

      expect(graph.nodes[1].id).toBe("step-0.then-0");
      expect(graph.nodes[1].data).toEqual({ slug: "success", type: "agent", prompt: "It worked" });
      expect(graph.nodes[1].parent).toEqual({ nodeId: "step-0", branch: "then" });

      // Edge: labeled "then" from if node to branch step
      const branchEdge = graph.edges.find((e) => e.label === "then");
      expect(branchEdge).toEqual({
        id: "step-0->then",
        source: "step-0",
        target: "step-0.then-0",
        label: "then",
        sourceHandle: "step-0-then",
      });
    });

    test("if with then and else branches creates both sets of nodes", () => {
      const steps: StepData[] = [
        {
          slug: "branch",
          type: "if",
          condition: { ref: "{{trigger.value}}", gt: 10 },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [{ slug: "high", type: "agent", prompt: "High value" }],
          else: [{ slug: "low", type: "agent", prompt: "Low value" }],
        },
      ];
      const graph = flattenWorkflow(steps);

      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes[1].id).toBe("step-0.then-0");
      expect(graph.nodes[1].parent).toEqual({ nodeId: "step-0", branch: "then" });
      expect(graph.nodes[2].id).toBe("step-0.else-0");
      expect(graph.nodes[2].parent).toEqual({ nodeId: "step-0", branch: "else" });

      const thenEdge = graph.edges.find((e) => e.label === "then");
      const elseEdge = graph.edges.find((e) => e.label === "else");
      expect(thenEdge).not.toBeNull();
      expect(elseEdge).toEqual({
        id: "step-0->else",
        source: "step-0",
        target: "step-0.else-0",
        label: "else",
        sourceHandle: "step-0-else",
      });
    });

    test("if branch with multiple sequential steps connects them", () => {
      const steps: StepData[] = [
        {
          slug: "gate",
          type: "if",
          condition: { ref: "{{trigger.ok}}", exists: true },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [
            { slug: "step-a", type: "agent", prompt: "A" },
            { slug: "step-b", type: "agent", prompt: "B" },
          ],
        },
      ];
      const graph = flattenWorkflow(steps);

      expect(graph.nodes).toHaveLength(3); // if + 2 then-steps
      // Sequential edge within the then branch
      const seqEdge = graph.edges.find((e) => e.source === "step-0.then-0" && e.target === "step-0.then-1");
      expect(seqEdge).not.toBeUndefined();
    });
  });

  describe("case nodes", () => {
    test("case with multiple paths creates branch nodes per path", () => {
      const steps: StepData[] = [
        {
          slug: "router",
          type: "case",
          match: "{{trigger.action}}",
          paths: {
            create: [{ slug: "do-create", type: "agent", prompt: "Create" }],
            update: [{ slug: "do-update", type: "agent", prompt: "Update" }],
          },
        },
      ];
      const graph = flattenWorkflow(steps);

      expect(graph.nodes).toHaveLength(3); // case + 2 path steps
      expect(graph.nodes[0].data.type).toBe("case");
      expect(graph.nodes[0].data).not.toHaveProperty("paths");
      expect(graph.nodes[0].data).not.toHaveProperty("default");

      const createNode = graph.nodes.find((n) => n.id === "step-0.path-create-0");
      expect(createNode).not.toBeUndefined();
      expect(createNode!.parent).toEqual({ nodeId: "step-0", branch: "create" });

      const updateNode = graph.nodes.find((n) => n.id === "step-0.path-update-0");
      expect(updateNode).not.toBeUndefined();
      expect(updateNode!.parent).toEqual({ nodeId: "step-0", branch: "update" });

      // Branch edges with labels
      const createEdge = graph.edges.find((e) => e.label === "create");
      expect(createEdge).toEqual({
        id: "step-0->path-create",
        source: "step-0",
        target: "step-0.path-create-0",
        label: "create",
        sourceHandle: "step-0-path-create",
      });
    });

    test("case with default path creates default branch", () => {
      const steps: StepData[] = [
        {
          slug: "switch",
          type: "case",
          match: "{{trigger.type}}",
          paths: {
            a: [{ slug: "handle-a", type: "agent", prompt: "A" }],
          },
          default: [{ slug: "fallback", type: "agent", prompt: "Default" }],
        },
      ];
      const graph = flattenWorkflow(steps);

      const defaultNode = graph.nodes.find((n) => n.id === "step-0.default-0");
      expect(defaultNode).not.toBeUndefined();
      expect(defaultNode!.parent).toEqual({ nodeId: "step-0", branch: "default" });

      const defaultEdge = graph.edges.find((e) => e.label === "default");
      expect(defaultEdge).toEqual({
        id: "step-0->default",
        source: "step-0",
        target: "step-0.default-0",
        label: "default",
        sourceHandle: "step-0-default",
      });
    });
  });

  describe("nested control flow", () => {
    test("if inside if produces deeply nested node IDs", () => {
      const steps: StepData[] = [
        {
          slug: "outer",
          type: "if",
          condition: { ref: "{{a}}", eq: "1" },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [
            {
              slug: "inner",
              type: "if",
              condition: { ref: "{{b}}", eq: "2" },
              // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
              then: [{ slug: "deep", type: "agent", prompt: "Deep" }],
            },
          ],
        },
      ];
      const graph = flattenWorkflow(steps);

      // outer-if, inner-if, deep-agent
      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes[0].id).toBe("step-0");
      expect(graph.nodes[1].id).toBe("step-0.then-0");
      expect(graph.nodes[2].id).toBe("step-0.then-0.then-0");
      expect(graph.nodes[2].parent).toEqual({ nodeId: "step-0.then-0", branch: "then" });
    });

    test("case inside if then branch", () => {
      const steps: StepData[] = [
        {
          slug: "gate",
          type: "if",
          condition: { ref: "{{ok}}", exists: true },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [
            {
              slug: "dispatch",
              type: "case",
              match: "{{trigger.cmd}}",
              paths: {
                run: [{ slug: "exec", type: "agent", prompt: "Run it" }],
              },
            },
          ],
        },
      ];
      const graph = flattenWorkflow(steps);

      expect(graph.nodes).toHaveLength(3); // if, case, agent
      const caseNode = graph.nodes.find((n) => n.data.slug === "dispatch");
      expect(caseNode!.id).toBe("step-0.then-0");

      const execNode = graph.nodes.find((n) => n.data.slug === "exec");
      expect(execNode!.id).toBe("step-0.then-0.path-run-0");
      expect(execNode!.parent).toEqual({ nodeId: "step-0.then-0", branch: "run" });
    });
  });

  describe("mixed workflows", () => {
    test("linear steps before and after a control flow node", () => {
      const steps: StepData[] = [
        { slug: "setup", type: "agent", prompt: "Setup" },
        {
          slug: "check",
          type: "if",
          condition: { ref: "{{setup.ok}}", eq: "true" },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [{ slug: "proceed", type: "agent", prompt: "Go" }],
        },
        { slug: "cleanup", type: "agent", prompt: "Cleanup" },
      ];
      const graph = flattenWorkflow(steps);

      // Top-level: setup, check, cleanup + branch: proceed
      expect(graph.nodes).toHaveLength(4);

      // Sequential edges at root level: setup->check, check->cleanup
      const rootSeqEdges = graph.edges.filter((e) => !e.label && !e.source.includes(".") && !e.target.includes("."));
      expect(rootSeqEdges).toHaveLength(2);
      expect(rootSeqEdges[0].source).toBe("step-0");
      expect(rootSeqEdges[0].target).toBe("step-1");
      expect(rootSeqEdges[1].source).toBe("step-1");
      expect(rootSeqEdges[1].target).toBe("step-2");
    });
  });

  describe("empty inputs", () => {
    test("empty step array produces empty graph", () => {
      const graph = flattenWorkflow([]);
      expect(graph.nodes).toHaveLength(0);
      expect(graph.edges).toHaveLength(0);
    });
  });
});

describe("unflattenWorkflow", () => {
  describe("linear workflows", () => {
    test("single node reconstructs to single step", () => {
      const graph: FlatGraph = {
        nodes: [{ id: "step-0", data: { slug: "greet", type: "agent", prompt: "Hi" }, parent: null }],
        edges: [],
      };
      const steps = unflattenWorkflow(graph);

      expect(steps).toHaveLength(1);
      expect(steps[0]).toEqual({ slug: "greet", type: "agent", prompt: "Hi" });
    });

    test("multiple sequential nodes reconstruct in order", () => {
      const graph: FlatGraph = {
        nodes: [
          { id: "step-0", data: { slug: "a", type: "agent", prompt: "A" }, parent: null },
          { id: "step-1", data: { slug: "b", type: "agent", prompt: "B" }, parent: null },
        ],
        edges: [{ id: "step-0->step-1", source: "step-0", target: "step-1" }],
      };
      const steps = unflattenWorkflow(graph);

      expect(steps).toHaveLength(2);
      expect(steps[0].slug).toBe("a");
      expect(steps[1].slug).toBe("b");
    });
  });

  describe("if nodes", () => {
    test("reconstructs if with then branch", () => {
      const graph: FlatGraph = {
        nodes: [
          {
            id: "step-0",
            data: { slug: "check", type: "if", condition: { ref: "{{x}}", eq: "1" } },
            parent: null,
          },
          {
            id: "step-0.then-0",
            data: { slug: "yes", type: "agent", prompt: "Yes" },
            parent: { nodeId: "step-0", branch: "then" },
          },
        ],
        edges: [
          { id: "step-0->then", source: "step-0", target: "step-0.then-0", label: "then", sourceHandle: "step-0-then" },
        ],
      };
      const steps = unflattenWorkflow(graph);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("if");
      expect((steps[0] as any).then).toEqual([{ slug: "yes", type: "agent", prompt: "Yes" }]);
      expect((steps[0] as any).else).toBeUndefined();
    });

    test("reconstructs if with then and else branches", () => {
      const graph: FlatGraph = {
        nodes: [
          {
            id: "step-0",
            data: { slug: "branch", type: "if", condition: { ref: "{{v}}", gt: 5 } },
            parent: null,
          },
          {
            id: "step-0.then-0",
            data: { slug: "high", type: "agent", prompt: "High" },
            parent: { nodeId: "step-0", branch: "then" },
          },
          {
            id: "step-0.else-0",
            data: { slug: "low", type: "agent", prompt: "Low" },
            parent: { nodeId: "step-0", branch: "else" },
          },
        ],
        edges: [
          { id: "step-0->then", source: "step-0", target: "step-0.then-0", label: "then", sourceHandle: "step-0-then" },
          { id: "step-0->else", source: "step-0", target: "step-0.else-0", label: "else", sourceHandle: "step-0-else" },
        ],
      };
      const steps = unflattenWorkflow(graph);

      expect(steps).toHaveLength(1);
      expect((steps[0] as any).then).toEqual([{ slug: "high", type: "agent", prompt: "High" }]);
      expect((steps[0] as any).else).toEqual([{ slug: "low", type: "agent", prompt: "Low" }]);
    });
  });

  describe("case nodes", () => {
    test("reconstructs case with paths and default", () => {
      const graph: FlatGraph = {
        nodes: [
          {
            id: "step-0",
            data: { slug: "router", type: "case", match: "{{action}}" },
            parent: null,
          },
          {
            id: "step-0.path-create-0",
            data: { slug: "do-create", type: "agent", prompt: "Create" },
            parent: { nodeId: "step-0", branch: "create" },
          },
          {
            id: "step-0.default-0",
            data: { slug: "fallback", type: "agent", prompt: "Default" },
            parent: { nodeId: "step-0", branch: "default" },
          },
        ],
        edges: [
          {
            id: "step-0->path-create",
            source: "step-0",
            target: "step-0.path-create-0",
            label: "create",
            sourceHandle: "step-0-path-create",
          },
          {
            id: "step-0->default",
            source: "step-0",
            target: "step-0.default-0",
            label: "default",
            sourceHandle: "step-0-default",
          },
        ],
      };
      const steps = unflattenWorkflow(graph);

      expect(steps).toHaveLength(1);
      expect((steps[0] as any).paths).toEqual({
        create: [{ slug: "do-create", type: "agent", prompt: "Create" }],
      });
      expect((steps[0] as any).default).toEqual([{ slug: "fallback", type: "agent", prompt: "Default" }]);
    });
  });

  describe("roundtrip", () => {
    test("flatten then unflatten produces equivalent structure for linear workflow", () => {
      const original: StepData[] = [
        { slug: "a", type: "agent", prompt: "A" },
        { slug: "b", type: "http-request", url: "https://x.com", method: "POST" },
        { slug: "c", type: "emit", event: "done" },
      ];
      const roundtripped = unflattenWorkflow(flattenWorkflow(original));
      expect(roundtripped).toEqual(original);
    });

    test("flatten then unflatten produces equivalent structure for if/else", () => {
      const original: StepData[] = [
        {
          slug: "check",
          type: "if",
          condition: { ref: "{{trigger.status}}", eq: "active" },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [
            { slug: "handle", type: "agent", prompt: "Handle active" },
            { slug: "notify", type: "emit", event: "handled" },
          ],
          else: [{ slug: "skip", type: "agent", prompt: "Skip" }],
        },
      ];
      const roundtripped = unflattenWorkflow(flattenWorkflow(original));
      expect(roundtripped).toEqual(original);
    });

    test("flatten then unflatten produces equivalent structure for case with default", () => {
      const original: StepData[] = [
        {
          slug: "dispatch",
          type: "case",
          match: "{{trigger.cmd}}",
          paths: {
            start: [{ slug: "do-start", type: "agent", prompt: "Start" }],
            stop: [{ slug: "do-stop", type: "agent", prompt: "Stop" }],
          },
          default: [{ slug: "unknown", type: "agent", prompt: "Unknown" }],
        },
      ];
      const roundtripped = unflattenWorkflow(flattenWorkflow(original));
      expect(roundtripped).toEqual(original);
    });

    test("flatten then unflatten produces equivalent structure for nested control flow", () => {
      const original: StepData[] = [
        { slug: "setup", type: "agent", prompt: "Setup" },
        {
          slug: "outer",
          type: "if",
          condition: { ref: "{{setup.ok}}", exists: true },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [
            {
              slug: "inner",
              type: "case",
              match: "{{setup.mode}}",
              paths: {
                fast: [{ slug: "quick", type: "agent", prompt: "Quick" }],
                slow: [
                  { slug: "wait", type: "waitFor", event: "ready", timeout: 5000 },
                  { slug: "proceed", type: "agent", prompt: "Proceed" },
                ],
              },
            },
          ],
          else: [{ slug: "abort", type: "emit", event: "aborted" }],
        },
        { slug: "done", type: "agent", prompt: "Done" },
      ];
      const roundtripped = unflattenWorkflow(flattenWorkflow(original));
      expect(roundtripped).toEqual(original);
    });
  });
});
