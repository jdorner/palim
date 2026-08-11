import { describe, expect, test } from "bun:test";
import path from "node:path";
import * as fc from "fast-check";
import { generateExtensionTsconfig } from "./externalDependencyResolver";

describe("generateExtensionTsconfig", () => {
  test("produces correct structure for known input paths", () => {
    const extensionDir = "/home/joe/palim-work/.palim/extensions/my-ext";
    const coreProjectDir = "/home/joe/projects/palim";

    const result = generateExtensionTsconfig(extensionDir, coreProjectDir);

    expect(result._managed).toBe(true);
    expect(result.include).toEqual(["./**/*.ts"]);
    expect(result.exclude).toEqual(["node_modules"]);

    const opts = result.compilerOptions;
    expect(opts.target).toBe("ESNext");
    expect(opts.module).toBe("Preserve");
    expect(opts.moduleResolution).toBe("bundler");
    expect(opts.strict).toBe(true);
    expect(opts.noUncheckedIndexedAccess).toBe(true);
    expect(opts.noImplicitOverride).toBe(true);
    expect(opts.noFallthroughCasesInSwitch).toBe(true);
    expect(opts.allowImportingTsExtensions).toBe(true);
    expect(opts.verbatimModuleSyntax).toBe(true);
    expect(opts.noEmit).toBe(true);
    expect(opts.skipLibCheck).toBe(true);
  });

  test("computes relative paths correctly from extension to core project", () => {
    const extensionDir = "/home/joe/palim-work/.palim/extensions/my-ext";
    const coreProjectDir = "/home/joe/projects/palim";

    const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
    const relative = "../../../../projects/palim";

    expect(result.compilerOptions.typeRoots).toEqual([`${relative}/node_modules/@types`]);

    expect(result.compilerOptions.paths["@ext/types"]).toEqual([`${relative}/src/extensions/types.ts`]);
    expect(result.compilerOptions.paths["@ext/sdk"]).toEqual([`${relative}/src/extensions/sdk.ts`]);
    expect(result.compilerOptions.paths["@src/*"]).toBeUndefined();
    expect(result.compilerOptions.paths["@shared/*"]).toBeUndefined();
    expect(result.compilerOptions.paths["*"]).toEqual(["./node_modules/*", `${relative}/node_modules/*`]);
  });

  test("handles sibling directory layout", () => {
    const extensionDir = "/opt/extensions/ext-a";
    const coreProjectDir = "/opt/palim";

    const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
    const relative = "../../palim";

    expect(result.compilerOptions.typeRoots).toEqual([`${relative}/node_modules/@types`]);
    expect(result.compilerOptions.paths["@ext/types"]).toEqual([`${relative}/src/extensions/types.ts`]);
    expect(result.compilerOptions.paths["*"]).toEqual(["./node_modules/*", `${relative}/node_modules/*`]);
  });

  test("handles same-parent directory", () => {
    const extensionDir = "/project/extensions/my-ext";
    const coreProjectDir = "/project";

    const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
    const relative = "../..";

    expect(result.compilerOptions.typeRoots).toEqual([`${relative}/node_modules/@types`]);
    expect(result.compilerOptions.paths["@src/*"]).toBeUndefined();
    expect(result.compilerOptions.paths["*"]).toEqual(["./node_modules/*", `${relative}/node_modules/*`]);
  });
});

// Feature: external-extension-deps, Property 1: Tsconfig path aliases resolve to core project source files
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 7.9**
describe("generateExtensionTsconfig - Property Tests", () => {
  /**
   * Arbitrary that generates a valid multi-segment absolute Unix path.
   * Produces paths like /a/b/c with 2-6 segments of alphanumeric names.
   */
  const pathSegmentArb = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);

  const absolutePathArb = fc
    .array(pathSegmentArb, { minLength: 2, maxLength: 6 })
    .map((segments) => `/${segments.join("/")}`);

  /**
   * Arbitrary that generates a pair of distinct absolute paths.
   * Extensions are always located in a different directory than the core project,
   * so we filter out cases where both paths are identical.
   */
  const distinctPathPairArb = fc.tuple(absolutePathArb, absolutePathArb).filter(([a, b]) => a !== b);

  describe("Property 1: Tsconfig path aliases resolve to core project source files", () => {
    test("@ext/types resolves to coreProjectDir/src/extensions/types.ts", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          const typesPath = result.compilerOptions.paths["@ext/types"]![0]!;
          const resolved = path.resolve(extensionDir, typesPath);
          expect(resolved).toBe(path.join(coreProjectDir, "src/extensions/types.ts"));
        }),
      );
    });

    test("@ext/sdk resolves to coreProjectDir/src/extensions/sdk.ts", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          const sdkPath = result.compilerOptions.paths["@ext/sdk"]![0]!;
          const resolved = path.resolve(extensionDir, sdkPath);
          expect(resolved).toBe(path.join(coreProjectDir, "src/extensions/sdk.ts"));
        }),
      );
    });

    test("@src/* is not exposed to external extensions", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.paths["@src/*"]).toBeUndefined();
        }),
      );
    });

    test("@shared/* is not exposed to external extensions", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.paths["@shared/*"]).toBeUndefined();
        }),
      );
    });

    test("typeRoots resolves to coreProjectDir/node_modules/@types", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          const typeRootsEntry = result.compilerOptions.typeRoots[0]!;
          const resolved = path.resolve(extensionDir, typeRootsEntry);
          expect(resolved).toBe(path.join(coreProjectDir, "node_modules/@types"));
        }),
      );
    });

    test("* (node_modules) first entry is local, second resolves to coreProjectDir/node_modules/", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          const nodeModulesEntries = result.compilerOptions.paths["*"]!;
          expect(nodeModulesEntries.length).toBe(2);

          // First entry: local node_modules
          expect(nodeModulesEntries[0]).toBe("./node_modules/*");

          // Second entry: core project node_modules
          const coreNodeModulesPrefix = nodeModulesEntries[1]!.replace(/\*$/, "");
          const resolved = path.resolve(extensionDir, coreNodeModulesPrefix);
          expect(resolved).toBe(path.join(coreProjectDir, "node_modules"));
        }),
      );
    });
  });

  // Feature: external-extension-deps, Property 2: Tsconfig contains all required compiler options
  // **Validates: Requirements 2.1, 2.3, 2.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.10**
  describe("Property 2: Tsconfig contains all required compiler options", () => {
    test("_managed is always true (Req 7.10)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result._managed).toBe(true);
        }),
      );
    });

    test("target is always ESNext (Req 7.1)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.target).toBe("ESNext");
        }),
      );
    });

    test("module is always Preserve (Req 7.2)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.module).toBe("Preserve");
        }),
      );
    });

    test("moduleResolution is always bundler (Req 7.3, 2.1)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.moduleResolution).toBe("bundler");
        }),
      );
    });

    test("strict is always true (Req 7.4, 2.3)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.strict).toBe(true);
        }),
      );
    });

    test("noUncheckedIndexedAccess is always true (Req 2.3)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.noUncheckedIndexedAccess).toBe(true);
        }),
      );
    });

    test("noImplicitOverride is always true (Req 2.3)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.noImplicitOverride).toBe(true);
        }),
      );
    });

    test("noFallthroughCasesInSwitch is always true (Req 2.3)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.noFallthroughCasesInSwitch).toBe(true);
        }),
      );
    });

    test("allowImportingTsExtensions is always true (Req 7.5)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.allowImportingTsExtensions).toBe(true);
        }),
      );
    });

    test("verbatimModuleSyntax is always true (Req 7.6)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.verbatimModuleSyntax).toBe(true);
        }),
      );
    });

    test("noEmit is always true (Req 7.7, 2.4)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.noEmit).toBe(true);
        }),
      );
    });

    test("skipLibCheck is always true", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.skipLibCheck).toBe(true);
        }),
      );
    });

    test("typeRoots is a non-empty array with entries containing node_modules (Req 7.8)", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.compilerOptions.typeRoots.length).toBeGreaterThan(0);
          for (const entry of result.compilerOptions.typeRoots) {
            expect(entry).toContain("node_modules");
          }
        }),
      );
    });

    test("include and exclude are present with expected values", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const result = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(result.include).toEqual(["./**/*.ts"]);
          expect(result.exclude).toEqual(["node_modules"]);
        }),
      );
    });
  });

  // Feature: external-extension-deps, Property 3: Managed tsconfig is idempotent
  // **Validates: Requirements 1.6**
  describe("Property 3: Managed tsconfig is idempotent", () => {
    test("generating tsconfig twice with same inputs produces identical output", () => {
      fc.assert(
        fc.property(distinctPathPairArb, ([extensionDir, coreProjectDir]) => {
          const first = generateExtensionTsconfig(extensionDir, coreProjectDir);
          const second = generateExtensionTsconfig(extensionDir, coreProjectDir);
          expect(second).toEqual(first);
        }),
      );
    });

    test("generating tsconfig with a different core project path produces different paths", () => {
      fc.assert(
        fc.property(
          fc
            .tuple(absolutePathArb, absolutePathArb, absolutePathArb)
            .filter(([ext, core1, core2]) => ext !== core1 && ext !== core2 && core1 !== core2),
          ([extensionDir, coreProjectDir1, coreProjectDir2]) => {
            const first = generateExtensionTsconfig(extensionDir, coreProjectDir1);
            const second = generateExtensionTsconfig(extensionDir, coreProjectDir2);
            // Paths should differ when the core project path changes
            expect(second.compilerOptions.paths["@ext/types"]).not.toEqual(first.compilerOptions.paths["@ext/types"]);
            expect(second.compilerOptions.paths["@ext/sdk"]).not.toEqual(first.compilerOptions.paths["@ext/sdk"]);
            expect(second.compilerOptions.typeRoots).not.toEqual(first.compilerOptions.typeRoots);
          },
        ),
      );
    });
  });
});

// Feature: external-extension-deps, Property 10: Tsconfig generation resilience
// **Validates: Requirements 1.7, 5.4**
describe("generateExtensionTsconfig - Property 10: Tsconfig generation resilience", () => {
  /**
   * Arbitrary that generates deeply nested or unusual (but valid) absolute paths
   * that would never exist on the filesystem.
   */
  const deepPathSegmentArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/);

  const nonExistentPathArb = fc
    .array(deepPathSegmentArb, { minLength: 4, maxLength: 10 })
    .map((segments) => `/${segments.join("/")}`);

  const nonExistentPathPairArb = fc.tuple(nonExistentPathArb, nonExistentPathArb).filter(([a, b]) => a !== b);

  test("always produces a valid JSON-serializable tsconfig for non-existent paths", () => {
    fc.assert(
      fc.property(nonExistentPathPairArb, ([extensionDir, coreProjectDir]) => {
        const result = generateExtensionTsconfig(extensionDir, coreProjectDir);

        // Must not throw when serializing to JSON
        const json = JSON.stringify(result);
        // Must produce valid JSON that can be parsed back
        const parsed = JSON.parse(json);
        expect(parsed).toEqual(result);
      }),
    );
  });

  test("always contains all required structural fields", () => {
    fc.assert(
      fc.property(nonExistentPathPairArb, ([extensionDir, coreProjectDir]) => {
        const result = generateExtensionTsconfig(extensionDir, coreProjectDir);

        // Required top-level fields
        expect(result._managed).toBe(true);
        expect(result.compilerOptions).toBeDefined();
        expect(result.include).toEqual(["./**/*.ts"]);
        expect(result.exclude).toEqual(["node_modules"]);

        // Required path aliases
        expect(result.compilerOptions.paths["@ext/types"]).toBeDefined();
        expect(result.compilerOptions.paths["@ext/sdk"]).toBeDefined();
        expect(result.compilerOptions.paths["@src/*"]).toBeUndefined();
        expect(result.compilerOptions.paths["@shared/*"]).toBeUndefined();
        expect(result.compilerOptions.paths["*"]).toBeDefined();

        // Required typeRoots
        expect(result.compilerOptions.typeRoots.length).toBeGreaterThan(0);
      }),
    );
  });

  test("path aliases still resolve correctly even for non-existent core directories", () => {
    fc.assert(
      fc.property(nonExistentPathPairArb, ([extensionDir, coreProjectDir]) => {
        const result = generateExtensionTsconfig(extensionDir, coreProjectDir);

        // @ext/types resolves to coreProjectDir/src/extensions/types.ts
        const typesPath = result.compilerOptions.paths["@ext/types"]![0]!;
        const resolvedTypes = path.resolve(extensionDir, typesPath);
        expect(resolvedTypes).toBe(path.join(coreProjectDir, "src/extensions/types.ts"));

        // @ext/sdk resolves to coreProjectDir/src/extensions/sdk.ts
        const sdkPath = result.compilerOptions.paths["@ext/sdk"]![0]!;
        const resolvedSdk = path.resolve(extensionDir, sdkPath);
        expect(resolvedSdk).toBe(path.join(coreProjectDir, "src/extensions/sdk.ts"));

        // typeRoots resolves to coreProjectDir/node_modules/@types
        const typeRootsEntry = result.compilerOptions.typeRoots[0]!;
        const resolvedTypeRoots = path.resolve(extensionDir, typeRootsEntry);
        expect(resolvedTypeRoots).toBe(path.join(coreProjectDir, "node_modules/@types"));
      }),
    );
  });

  test("all path values are non-empty strings", () => {
    fc.assert(
      fc.property(nonExistentPathPairArb, ([extensionDir, coreProjectDir]) => {
        const result = generateExtensionTsconfig(extensionDir, coreProjectDir);

        for (const [, paths] of Object.entries(result.compilerOptions.paths)) {
          for (const p of paths) {
            expect(p.length).toBeGreaterThan(0);
            expect(typeof p).toBe("string");
          }
        }

        for (const tr of result.compilerOptions.typeRoots) {
          expect(tr.length).toBeGreaterThan(0);
          expect(typeof tr).toBe("string");
        }
      }),
    );
  });
});
