/**
 * Barrel export for the extension system.
 */

export { serverOrigin } from "@src/config";
export { EventBus } from "./eventBus";
export type { RegistryInitDeps } from "./registry";
export { ExtensionRegistry, getExtensionBaseUrl } from "./registry";
export type {
  AgentEventContext,
  CoreQueueName,
  EventCallback,
  EventParam,
  EventType,
  Extension,
  ExtensionContext,
  ExtensionManifest,
  HttpMethod,
  QueueContext,
  RouteHandler,
  RouteRegistry,
  RunAgentOptions,
  SecretsContext,
  SkillScriptContext,
  SkillsContext,
} from "./types";
