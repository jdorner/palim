/**
 * TypeBox schemas for the excel workflow step configuration.
 *
 * Validates the step definition at execution time to ensure all required
 * fields are present and correctly typed before writing the Excel file.
 */

import { type Static, Type } from "@sinclair/typebox";

/** Schema for a single column definition in an Excel sheet. */
export const ColumnSchema = Type.Object({
  header: Type.String({ minLength: 1, description: "Column header text displayed in the first row" }),
  key: Type.String({ minLength: 1, description: "Key used to extract values from data objects" }),
  width: Type.Optional(Type.Number({ minimum: 1, description: "Column width in characters" })),
  numFmt: Type.Optional(Type.String({ description: "Excel number format string (e.g. '$#,##0.00')" })),
  type: Type.Optional(
    Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("date")], {
      description:
        "Expected value type. When set, values are coerced (e.g. '5,55' -> 5.55 for number columns). Inferred from numFmt if omitted.",
    }),
  ),
});

/** Schema for a single sheet definition in the Excel step. */
export const SheetSchema = Type.Object({
  name: Type.String({ minLength: 1, description: "Sheet tab name" }),
  columns: Type.Array(ColumnSchema, { minItems: 1, description: "Column definitions for the sheet" }),
  data: Type.Union([Type.String(), Type.Array(Type.Unknown())], {
    description: "Row data: either a template expression string or a literal array of objects",
  }),
});

/** Schema for the full excel step configuration (excluding slug and type). */
export const ExcelStepConfigSchema = Type.Object({
  mode: Type.Union([Type.Literal("create"), Type.Literal("append")], {
    description: "'create' overwrites existing files; 'append' adds rows to an existing file (errors if missing)",
  }),
  path: Type.String({ minLength: 1, description: "Output directory path relative to the work directory" }),
  filename: Type.String({ minLength: 1, description: "Output filename (supports template expressions)" }),
  sheets: Type.Array(SheetSchema, { minItems: 1, description: "Sheet definitions" }),
});

/** TypeScript type for a column definition. */
export type ColumnDef = Static<typeof ColumnSchema>;

/** TypeScript type for a sheet definition. */
export type SheetDef = Static<typeof SheetSchema>;

/** TypeScript type for the full excel step config. */
export type ExcelStepConfig = Static<typeof ExcelStepConfigSchema>;
