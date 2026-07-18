/**
 * Dependency resolution for extensions using Kahn's algorithm (topological sort).
 *
 * Handles:
 * - Valid acyclic dependency graphs -> returns extensions in dependency order
 * - Circular dependencies -> detected and returned separately
 * - Missing dependencies -> treated as unresolvable, returned in circular set
 */

import type { Extension } from "./types";

export interface DependencyResolutionResult {
  /** Extensions in valid initialization order (dependencies before dependents). */
  ordered: Extension[];
  /** Extensions that could not be loaded due to cycles or missing deps. */
  excluded: Extension[];
  /** Human-readable error messages for each problem detected. */
  errors: string[];
}

/**
 * Resolve the initialization order for a set of extensions based on their
 * declared dependencies. Uses Kahn's algorithm for topological sorting.
 *
 * @param extensions Set of extensions to sort by dependency.
 * @returns Result with ordered extensions, exclusions, and any errors.
 */
export function resolveDependencyOrder(extensions: Extension[]): DependencyResolutionResult {
  const errors: string[] = [];
  const byName = new Map<string, Extension>();

  for (const ext of extensions) {
    byName.set(ext.manifest.name, ext);
  }

  // --- 1. Identify extensions with missing dependencies ---
  const viable = new Set<string>();
  const excludedNames = new Set<string>();

  for (const ext of extensions) {
    const missing = (ext.manifest.dependencies ?? []).filter((dep) => !byName.has(dep));
    if (missing.length > 0) {
      errors.push(`Extension "${ext.manifest.name}" depends on missing extensions: ${missing.join(", ")}`);
      excludedNames.add(ext.manifest.name);
    } else {
      viable.add(ext.manifest.name);
    }
  }

  // --- 2. Build adjacency list and in-degree map for viable extensions ---
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep -> extensions that depend on it

  for (const name of viable) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  for (const name of viable) {
    const deps = byName.get(name)!.manifest.dependencies ?? [];
    for (const dep of deps) {
      if (!viable.has(dep)) {
        // Dependency was excluded (missing dep of its own) - cascade
        excludedNames.add(name);
        viable.delete(name);
        errors.push(`Extension "${name}" excluded because dependency "${dep}" was excluded`);
        break;
      }
    }
  }

  // Rebuild after cascade exclusions
  inDegree.clear();
  dependents.clear();
  for (const name of viable) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }
  for (const name of viable) {
    const deps = byName.get(name)!.manifest.dependencies ?? [];
    for (const dep of deps) {
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      dependents.get(dep)!.push(name);
    }
  }

  // --- 3. Kahn's algorithm ---
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const dependent of dependents.get(current) ?? []) {
      const newDegree = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  // --- 4. Anything still in viable but not in sorted is part of a cycle ---
  const sortedSet = new Set(sorted);
  for (const name of viable) {
    if (!sortedSet.has(name)) {
      excludedNames.add(name);
    }
  }

  const cyclicNames = [...viable].filter((n) => !sortedSet.has(n));
  if (cyclicNames.length > 0) {
    errors.push(`Circular dependency detected among extensions: ${cyclicNames.join(", ")}`);
  }

  return {
    ordered: sorted.map((name) => byName.get(name)!),
    excluded: [...excludedNames].map((name) => byName.get(name)!),
    errors,
  };
}
