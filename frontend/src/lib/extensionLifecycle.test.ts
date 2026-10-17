import { describe, expect, test } from "bun:test";
import type { ExtensionLifecycleEvent } from "$shared/extensions";
import { planLifecycleRefresh } from "./extensionLifecycle";

const ev = (action: ExtensionLifecycleEvent["action"], name = "foo"): ExtensionLifecycleEvent => ({
  type: "extension_lifecycle",
  action,
  name,
  version: "1.0.0",
});

describe("planLifecycleRefresh", () => {
  test("an update burst refetches the catalogs and only the updated extension's badges", () => {
    const plan = planLifecycleRefresh([ev("deactivated"), ev("unloaded"), ev("activated"), ev("loaded")]);
    expect(plan).toEqual({ reloadCatalogs: true, badgeExtensions: new Set(["foo"]), deactivated: new Set() });
  });

  test("stopping skips catalogs and badges, and reports deactivation", () => {
    expect(planLifecycleRefresh([ev("deactivated")])).toEqual({
      reloadCatalogs: false,
      badgeExtensions: new Set(),
      deactivated: new Set(["foo"]),
    });
    expect(planLifecycleRefresh([ev("deactivated"), ev("unloaded")]).deactivated).toEqual(new Set());
  });

  test("UI rebuilds refetch badges but not catalogs; catalog reloads refetch catalogs", () => {
    expect(planLifecycleRefresh([ev("ui_updated")])).toMatchObject({ reloadCatalogs: false });
    expect(planLifecycleRefresh([ev("locales_updated", "bar")])).toMatchObject({
      reloadCatalogs: true,
      badgeExtensions: new Set(["bar"]),
    });
  });
});
