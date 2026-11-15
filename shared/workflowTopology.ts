/**
 * Workflow topology - the single source of graph facts about a DAG workflow.
 *
 * Every rule that is derived purely from the steps and edges of a workflow
 * lives here: predecessors/successors, roots and terminals, ancestors,
 * dominators, iterator bodies and dead-branch propagation. The backend
 * validator, the run coordinator, the editor's autocomplete and the run view
 * all read the same analysis, so the editor cannot offer a reference the
 * runtime rejects (or the reverse).
 *
 * The analysis is total: it accepts half-built editor drafts (cycles,
 * duplicate slugs, edges to unknown steps, iterators without aggregators)
 * without throwing. Duplicate slugs keep their first occurrence; edges whose
 * endpoints are not known steps are ignored.
 *
 * @module
 */

/** A step as seen by the topology: its slug, type, and (for aggregators) the paired iterator. */
export interface TopologyStep {
  /** The step slug (the node identity in slug space). */
  slug: string;
  /** The step type (`iterator`, `aggregator`, `if`, ...). Non-strings are treated as unknown. */
  type?: unknown;
  /** For an aggregator: the slug of the iterator it collects. */
  iterator?: unknown;
}

/** An edge between two steps, in slug space. */
export interface TopologyEdge {
  from: string;
  to: string;
  /** Branch label (`then`/`else`, a case path, or `each` on an iterator's body edge). */
  branch?: string;
}

/** The body of an iterator: the steps re-run once per item, and the edges reset between passes. */
export interface IteratorBody {
  /** The iterator step slug. */
  iterator: string;
  /** The paired aggregator step slug. */
  aggregator: string;
  /** Body step slugs (excluding iterator and aggregator). */
  steps: ReadonlySet<string>;
  /** Body edges: `each` edges into the body, edges inside it, and edges from it to the aggregator. */
  edges: readonly TopologyEdge[];
  /** Body steps with no edge to another body step; the aggregator collects their results. */
  terminals: readonly string[];
}

/** The analysis of one workflow graph. Every lookup is computed lazily and memoized. */
export interface WorkflowTopology {
  /** All step slugs, in input order (duplicates removed). */
  readonly slugs: readonly string[];
  /** All edges between known steps, in input order. */
  readonly edges: readonly TopologyEdge[];
  /** Steps with no incoming edge, in input order. */
  readonly roots: readonly string[];
  /** Steps with no outgoing edge, in input order. */
  readonly terminals: readonly string[];
  /** Whether a slug names a step. */
  has(slug: string): boolean;
  /** The step type, or `undefined` for an unknown slug or a non-string type. */
  typeOf(slug: string): string | undefined;
  /** Edges ending at a step (empty for unknown slugs). */
  incoming(slug: string): readonly TopologyEdge[];
  /** Edges starting at a step (empty for unknown slugs). */
  outgoing(slug: string): readonly TopologyEdge[];
  /** Steps from which `slug` is reachable. Contains `slug` itself only when it lies on a cycle. */
  ancestors(slug: string): ReadonlySet<string>;
  /**
   * Steps on every path from a root to `slug`, including `slug` itself. A step
   * not reachable from any root (e.g. on a rootless cycle) is dominated by every step.
   */
  dominators(slug: string): ReadonlySet<string>;
  /**
   * Whether `ref` is guaranteed to have completed before `slug` runs: it is an
   * ancestor (runs before) and a dominator (never on a skippable branch).
   * False for `ref === slug`.
   */
  runsBefore(ref: string, slug: string): boolean;
  /** Steps in execution order: topological, input order among steps ready together, cycle members last. */
  executionOrder(): readonly string[];
  /** The aggregator paired with an iterator (the first aggregator naming it), if any. */
  aggregatorOf(iterator: string): string | undefined;
  /** The body of an iterator, or `null` when the step is not an iterator with an aggregator. */
  iteratorBody(iterator: string): IteratorBody | null;
  /** The iterator whose body contains `slug`, if any. */
  enclosingIterator(slug: string): string | undefined;
  /**
   * Steps that can no longer run given the branches chosen so far: an edge is
   * dead when it leaves a decided control-flow node on another branch, and a
   * step is dead when all of its incoming edges are dead or come from dead steps.
   *
   * @param chosenBranches - Map of control-flow step slug to the branch it took
   */
  deadSteps(chosenBranches: Readonly<Record<string, string>>): Set<string>;
}

/**
 * Builds the stable id of an edge, as used for run edge states.
 *
 * @param from - Source step slug
 * @param to - Target step slug
 * @param branch - Optional branch label
 * @returns `from:to` or `from:to:branch`
 */
export function edgeId(from: string, to: string, branch?: string): string {
  return branch ? `${from}:${to}:${branch}` : `${from}:${to}`;
}

/**
 * Converts a slug-keyed step record (the serialized workflow shape) into topology steps.
 *
 * @param steps - Step definitions keyed by slug
 * @returns One topology step per entry, in key order
 */
export function topologyStepsFromRecord(steps: Readonly<Record<string, { type?: unknown }>>): TopologyStep[] {
  return Object.entries(steps).map(([slug, def]) => ({
    slug,
    type: def.type,
    iterator: (def as { iterator?: unknown }).iterator,
  }));
}

/**
 * Analyzes a workflow graph.
 *
 * @param steps - The steps (an array, or a slug-keyed record as in a workflow definition)
 * @param edges - The edges in slug space
 * @returns The topology; lookups are computed on first use
 */
export function analyzeWorkflowGraph(
  steps: readonly TopologyStep[] | Readonly<Record<string, { type?: unknown }>>,
  edges: readonly TopologyEdge[],
): WorkflowTopology {
  const stepList = Array.isArray(steps)
    ? (steps as readonly TopologyStep[])
    : topologyStepsFromRecord(steps as Record<string, { type?: unknown }>);

  const byslug = new Map<string, TopologyStep>();
  for (const step of stepList) {
    if (typeof step.slug === "string" && !byslug.has(step.slug)) byslug.set(step.slug, step);
  }
  const slugs = [...byslug.keys()];
  const knownEdges = edges.filter((e) => byslug.has(e.from) && byslug.has(e.to));

  const incomingMap = new Map<string, TopologyEdge[]>();
  const outgoingMap = new Map<string, TopologyEdge[]>();
  for (const slug of slugs) {
    incomingMap.set(slug, []);
    outgoingMap.set(slug, []);
  }
  for (const e of knownEdges) {
    incomingMap.get(e.to)!.push(e);
    outgoingMap.get(e.from)!.push(e);
  }

  const roots = slugs.filter((s) => incomingMap.get(s)!.length === 0);
  const terminals = slugs.filter((s) => outgoingMap.get(s)!.length === 0);
  const EMPTY: readonly TopologyEdge[] = [];

  const typeOf = (slug: string): string | undefined => {
    const type = byslug.get(slug)?.type;
    return typeof type === "string" ? type : undefined;
  };

  // --- ancestors -----------------------------------------------------------
  const ancestorCache = new Map<string, Set<string>>();
  const ancestors = (slug: string): ReadonlySet<string> => {
    const cached = ancestorCache.get(slug);
    if (cached) return cached;
    const found = new Set<string>();
    const queue = (incomingMap.get(slug) ?? []).map((e) => e.from);
    while (queue.length > 0) {
      const cur = queue.pop()!;
      if (found.has(cur)) continue;
      found.add(cur);
      for (const e of incomingMap.get(cur)!) queue.push(e.from);
    }
    ancestorCache.set(slug, found);
    return found;
  };

  // --- dominators ----------------------------------------------------------
  // Iterative data-flow fixpoint: dom(root) = {root}; dom(n) = {n} + the
  // intersection of dom(p) over all predecessors p. Non-roots start
  // pessimistically dominated by every step and are narrowed until stable.
  let dominatorMap: Map<string, Set<string>> | undefined;
  const computeDominators = (): Map<string, Set<string>> => {
    const rootSet = new Set(roots);
    const dom = new Map<string, Set<string>>();
    for (const s of slugs) dom.set(s, rootSet.has(s) ? new Set([s]) : new Set(slugs));
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of slugs) {
        if (rootSet.has(s)) continue;
        let next: Set<string> | null = null;
        for (const e of incomingMap.get(s)!) {
          const pDom = dom.get(e.from)!;
          if (next === null) next = new Set(pDom);
          else for (const d of next) if (!pDom.has(d)) next.delete(d);
        }
        const merged = next ?? new Set<string>();
        merged.add(s);
        const prev = dom.get(s)!;
        if (prev.size !== merged.size || [...merged].some((d) => !prev.has(d))) {
          dom.set(s, merged);
          changed = true;
        }
      }
    }
    return dom;
  };
  const dominators = (slug: string): ReadonlySet<string> => {
    dominatorMap ??= computeDominators();
    return dominatorMap.get(slug) ?? new Set();
  };

  // --- execution order -----------------------------------------------------
  let order: string[] | undefined;
  const executionOrder = (): readonly string[] => {
    if (order) return order;
    const indegree = new Map(slugs.map((s) => [s, incomingMap.get(s)!.length]));
    const done = new Set<string>();
    const ordered: string[] = [];
    let ready = slugs.filter((s) => indegree.get(s) === 0);
    while (ready.length > 0) {
      const next = new Set<string>();
      for (const s of ready) {
        ordered.push(s);
        done.add(s);
        for (const e of outgoingMap.get(s)!) {
          const left = indegree.get(e.to)! - 1;
          indegree.set(e.to, left);
          if (left === 0) next.add(e.to);
        }
      }
      ready = slugs.filter((s) => next.has(s));
    }
    order = [...ordered, ...slugs.filter((s) => !done.has(s))];
    return order;
  };

  // --- iterators -----------------------------------------------------------
  const aggregatorOf = (iterator: string): string | undefined =>
    slugs.find((s) => typeOf(s) === "aggregator" && byslug.get(s)!.iterator === iterator);

  const bodyCache = new Map<string, IteratorBody | null>();
  const iteratorBody = (iterator: string): IteratorBody | null => {
    if (bodyCache.has(iterator)) return bodyCache.get(iterator)!;
    const aggregator = typeOf(iterator) === "iterator" ? aggregatorOf(iterator) : undefined;
    const body = aggregator === undefined ? null : computeBody(iterator, aggregator);
    bodyCache.set(iterator, body);
    return body;
  };

  // Body = steps forward-reachable from the iterator's `each` targets (not
  // passing through the aggregator) that also lead back to the aggregator
  // (not passing through the iterator). Steps branching off the body without
  // rejoining the aggregator run once, outside the loop.
  const computeBody = (iterator: string, aggregator: string): IteratorBody => {
    const forward = new Set<string>();
    const fq: string[] = [];
    for (const e of outgoingMap.get(iterator)!) {
      if (e.branch === "each" && !forward.has(e.to)) {
        forward.add(e.to);
        fq.push(e.to);
      }
    }
    while (fq.length > 0) {
      const cur = fq.shift()!;
      if (cur === aggregator) continue;
      for (const e of outgoingMap.get(cur)!) {
        if (!forward.has(e.to)) {
          forward.add(e.to);
          fq.push(e.to);
        }
      }
    }

    const backward = new Set<string>();
    const bq: string[] = [];
    for (const e of incomingMap.get(aggregator)!) {
      if (e.from !== iterator && !backward.has(e.from)) {
        backward.add(e.from);
        bq.push(e.from);
      }
    }
    while (bq.length > 0) {
      const cur = bq.shift()!;
      for (const e of incomingMap.get(cur)!) {
        if (e.from !== iterator && !backward.has(e.from)) {
          backward.add(e.from);
          bq.push(e.from);
        }
      }
    }

    const bodySteps = new Set<string>();
    for (const s of forward) {
      if (s !== aggregator && s !== iterator && backward.has(s)) bodySteps.add(s);
    }

    const bodyEdges = knownEdges.filter((e) => {
      const fromBody = bodySteps.has(e.from);
      const toBody = bodySteps.has(e.to);
      return (
        (fromBody && toBody) ||
        (e.from === iterator && e.branch === "each" && toBody) ||
        (fromBody && e.to === aggregator)
      );
    });

    const hasBodySuccessor = new Set<string>();
    for (const e of knownEdges) {
      if (bodySteps.has(e.from) && bodySteps.has(e.to)) hasBodySuccessor.add(e.from);
    }
    const bodyTerminals = [...bodySteps].filter((s) => !hasBodySuccessor.has(s));

    return { iterator, aggregator, steps: bodySteps, edges: bodyEdges, terminals: bodyTerminals };
  };

  let enclosingMap: Map<string, string> | undefined;
  const enclosingIterator = (slug: string): string | undefined => {
    if (!enclosingMap) {
      enclosingMap = new Map();
      for (const s of slugs) {
        const body = iteratorBody(s);
        if (!body) continue;
        for (const member of body.steps) if (!enclosingMap.has(member)) enclosingMap.set(member, s);
      }
    }
    return enclosingMap.get(slug);
  };

  // --- dead branches -------------------------------------------------------
  const deadSteps = (chosenBranches: Readonly<Record<string, string>>): Set<string> => {
    const deadEdge = (e: TopologyEdge): boolean => {
      const chosen = Object.hasOwn(chosenBranches, e.from) ? chosenBranches[e.from] : undefined;
      return chosen !== undefined && e.branch !== undefined && e.branch !== chosen;
    };
    const dead = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of slugs) {
        if (dead.has(s)) continue;
        const inc = incomingMap.get(s)!;
        if (inc.length > 0 && inc.every((e) => deadEdge(e) || dead.has(e.from))) {
          dead.add(s);
          changed = true;
        }
      }
    }
    return dead;
  };

  return {
    slugs,
    edges: knownEdges,
    roots,
    terminals,
    has: (slug) => byslug.has(slug),
    typeOf,
    incoming: (slug) => incomingMap.get(slug) ?? EMPTY,
    outgoing: (slug) => outgoingMap.get(slug) ?? EMPTY,
    ancestors,
    dominators,
    runsBefore: (ref, slug) => ref !== slug && ancestors(slug).has(ref) && dominators(slug).has(ref),
    executionOrder,
    aggregatorOf,
    iteratorBody,
    enclosingIterator,
    deadSteps,
  };
}
