/**
 * Tests for UI page declarations in extension manifests: schema rules and the
 * page/navigation cross-checks in validateUiPages.
 */

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { UiPageSchema } from "../types";
import { validateUiPages } from "./discovery";

const nav = (route: string) => ({ label: "Page", route, icon: "EnvelopeIcon", order: 1 });

describe("UiPageSchema", () => {
  test("accepts a page under ui/", () => {
    expect(Value.Check(UiPageSchema, { id: "accounts", title: "Mail accounts", entry: "ui/AccountsPage.svelte" })).toBe(
      true,
    );
    expect(Value.Check(UiPageSchema, { id: "a-2", title: "A", entry: "ui/pages/Nested.svelte" })).toBe(true);
  });

  test.each([
    ["uppercase id", { id: "Accounts", title: "A", entry: "ui/A.svelte" }],
    ["id with slash", { id: "a/b", title: "A", entry: "ui/A.svelte" }],
    ["entry outside ui/", { id: "a", title: "A", entry: "A.svelte" }],
    ["non-svelte entry", { id: "a", title: "A", entry: "ui/a.ts" }],
    ["empty title", { id: "a", title: "", entry: "ui/A.svelte" }],
  ])("rejects %s", (_label, page) => {
    expect(Value.Check(UiPageSchema, page)).toBe(false);
  });
});

describe("validateUiPages", () => {
  const pages = [{ id: "accounts" }, { id: "settings" }];

  test("accepts navigation to own declared pages and unrelated routes", () => {
    const ui = {
      pages,
      navigation: [nav("/ext-page/mail/accounts"), nav("/ext-page/mail"), nav("/workflows")],
    };
    expect(validateUiPages("mail", ui, "mail/index.ts")).toBe(true);
  });

  test("accepts a manifest without ui", () => {
    expect(validateUiPages("mail", undefined, "mail/index.ts")).toBe(true);
  });

  test("rejects duplicate page ids", () => {
    expect(validateUiPages("mail", { pages: [{ id: "a" }, { id: "a" }] }, "mail/index.ts")).toBe(false);
  });

  test("rejects navigation into another extension's pages", () => {
    expect(validateUiPages("mail", { pages, navigation: [nav("/ext-page/other/accounts")] }, "mail/index.ts")).toBe(
      false,
    );
  });

  test("rejects navigation to an undeclared page", () => {
    expect(validateUiPages("mail", { pages, navigation: [nav("/ext-page/mail/missing")] }, "mail/index.ts")).toBe(
      false,
    );
  });

  test("rejects /ext-page navigation when no pages are declared", () => {
    expect(validateUiPages("mail", { navigation: [nav("/ext-page/mail")] }, "mail/index.ts")).toBe(false);
  });
});
