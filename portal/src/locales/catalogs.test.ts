import { describe, expect, test } from "bun:test";
import { diffCatalogKeys } from "../../../shared/i18n";
import de from "./de.json";
import en from "./en.json";

describe("portal catalogs", () => {
  test("German has exactly the English keys", () => {
    expect(diffCatalogKeys(en, de)).toEqual({ missing: [], extra: [] });
  });
});
