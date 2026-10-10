/**
 * UI translation catalog routes.
 *
 * - `GET /api/i18n/:locale` - translation catalogs of all loaded extensions for
 *   a locale, plus their English fallback catalogs. Core UI catalogs are bundled
 *   with the frontend and not served here.
 *
 * @module
 */

import { isLocale } from "@shared/i18n";
import { Type } from "@sinclair/typebox";
import type { ExtensionRegistry } from "@src/extensions";
import { Elysia } from "elysia";

/**
 * Creates the i18n route group.
 *
 * @param getRegistry - Getter for the extension registry (may be undefined during startup)
 * @returns Elysia plugin with the catalog route
 */
export function i18nRoutes(getRegistry: () => ExtensionRegistry | undefined) {
  return new Elysia().get(
    "/api/i18n/:locale",
    ({ params, status }) => {
      if (!isLocale(params.locale)) return status(404, { error: `Unsupported locale "${params.locale}"` });
      const reg = getRegistry();
      return status(200, { locale: params.locale, extensions: reg ? reg.getLocaleCatalogs(params.locale) : {} });
    },
    { params: Type.Object({ locale: Type.String({ minLength: 1 }) }) },
  );
}
