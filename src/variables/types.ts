/**
 * Global variable type definitions for backend use.
 *
 * Re-exports the shared {@link GlobalVariableEntry} interface so backend modules
 * can import variable types from a single backend-local entry point.
 *
 * @module
 */

export type { GlobalVariableEntry } from "@shared/variables";
