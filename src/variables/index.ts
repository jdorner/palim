/**
 * Global variables module.
 *
 * Public types of the `VariableStore` (`./store`, SQLite-backed plaintext
 * key-value storage): the {@link TemplateVariableResolver} interface used by the workflow
 * template engine and validator. Unlike the secrets vault, variables carry no
 * encryption, ACL, or read audit logging.
 *
 * @module
 */

export type { TemplateVariableResolver } from "./store";
