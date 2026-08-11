/**
 * Barrel export for the extension system.
 */

export { serverOrigin } from "@src/config";
export { EventBus } from "./engine/eventBus";
export type { RegistryInitDeps } from "./engine/registry";
export { ExtensionRegistry, getExtensionBaseUrl } from "./engine/registry";
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
  QueueEventCallback,
  RouteHandler,
  RouteRegistry,
  RunAgentOptions,
  SkillScriptContext,
} from "./types";
