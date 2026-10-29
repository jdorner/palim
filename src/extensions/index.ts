/**
 * Barrel export for the extension system (core-internal; extension authors use
 * `@ext/types` and `@ext/sdk`).
 */

export type { RegistryInitDeps } from "./engine/registry";
export { ExtensionRegistry } from "./engine/registry";
export type {
  AgentEventContext,
  CoreQueueName,
  EventParam,
  HttpMethod,
  RouteHandler,
  RouteOptions,
  RouteRegistry,
  RunAgentOptions,
} from "./types";
