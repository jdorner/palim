import { describe, expect, test } from "bun:test";
import {
  createFormatters,
  createTranslator,
  diffCatalogKeys,
  flattenMessages,
  interpolate,
  isLocale,
  resolveLocale,
} from "./i18n";

describe("resolveLocale", () => {
  test("prefers a supported stored preference", () => {
    expect(resolveLocale("de", ["en-US"])).toBe("de");
  });

  test("falls back to the browser languages by primary subtag", () => {
    expect(resolveLocale(null, ["fr-FR", "de-AT", "en"])).toBe("de");
  });

  test("ignores unsupported preferences and defaults to English", () => {
    expect(resolveLocale("xx", ["fr"])).toBe("en");
    expect(isLocale("xx")).toBe(false);
  });
});

describe("flattenMessages / interpolate", () => {
  test("flattens nested catalogs to dot keys", () => {
    const flat = flattenMessages({ a: { b: "x", c: { d: "y" } }, e: "z" });
    expect([...flat.entries()]).toEqual([
      ["a.b", "x"],
      ["a.c.d", "y"],
      ["e", "z"],
    ]);
  });

  test("replaces known placeholders and keeps unknown ones", () => {
    expect(interpolate("Hi {name}, {missing}", { name: "Ann" })).toBe("Hi Ann, {missing}");
  });
});

describe("createTranslator", () => {
  const en = {
    common: { save: "Save", items_one: "{count} item", items_other: "{count} items" },
    only: "English only",
  };
  const de = { common: { save: "Speichern", items_one: "{count} Eintrag", items_other: "{count} Einträge" } };

  test("translates in the active locale", () => {
    const t = createTranslator("de", [de], [en]);
    expect(t("common.save")).toBe("Speichern");
  });

  test("falls back to English, then default, then the key", () => {
    const t = createTranslator("de", [de], [en]);
    expect(t("only")).toBe("English only");
    expect(t("nope", { default: "Fallback {n}", n: 1 })).toBe("Fallback 1");
    expect(t("nope")).toBe("nope");
  });

  test("selects plural forms by count", () => {
    const t = createTranslator("de", [de], [en]);
    expect(t("common.items", { count: 1 })).toBe("1 Eintrag");
    expect(t("common.items", { count: 3 })).toBe("3 Einträge");
    expect(t("common.items", { count: 0 })).toBe("0 Einträge");
    expect(t("common.items", { count: 1234 })).toBe("1.234 Einträge");
  });

  test("earlier catalogs take priority", () => {
    const t = createTranslator("en", [{ common: { save: "Store" } }, en]);
    expect(t("common.save")).toBe("Store");
  });
});

describe("createFormatters", () => {
  test("formats numbers per locale", () => {
    expect(createFormatters("de").number(1234.5)).toBe("1.234,5");
    expect(createFormatters("en").number(1234.5)).toBe("1,234.5");
  });

  test("formats relative times", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(createFormatters("en").relative(now - 3 * 60_000, now)).toBe("3 minutes ago");
    expect(createFormatters("de").relative(now - 3 * 60_000, now)).toBe("vor 3 Minuten");
  });
});

describe("diffCatalogKeys", () => {
  test("reports missing and extra keys, ignoring plural categories", () => {
    const diff = diffCatalogKeys({ a: "x", n_one: "1", n_other: "n", b: "y" }, { a: "x", n_other: "n", c: "z" });
    expect(diff).toEqual({ missing: ["b"], extra: ["c"] });
  });
});
