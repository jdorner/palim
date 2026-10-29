import { describe, expectTypeOf, test } from "bun:test";
import type { SecretSchemaEntry as SharedSecretSchemaEntry } from "@shared/extensions";
import type { SecretSchemaEntry } from "./types";

describe("SecretSchemaEntry", () => {
  test("the shared interface matches the TypeBox manifest schema", () => {
    // Compile-time check (enforced by `bunx tsc --noEmit`): the shared interface
    // used by the frontend and the vault must not drift from the schema that
    // validates extension manifests.
    expectTypeOf<SecretSchemaEntry>().toEqualTypeOf<SharedSecretSchemaEntry>();
  });
});
