/**
 * Global variables module.
 *
 * Provides the {@link VariableStore} (SQLite-backed plaintext key-value storage)
 * and the {@link TemplateVariableResolver} interface used by the workflow
 * template engine and validator. Unlike the secrets vault, variables carry no
 * encryption, ACL, or read audit logging.
 *
 * @module
 */

export { type TemplateVariableResolver, VariableStore } from "./store";
export type { GlobalVariableEntry } from "./types";
