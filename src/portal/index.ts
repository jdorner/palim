/**
 * Portal workflow launchers: workflows with a `portal` trigger that portal
 * users start from the portal (typically with an uploaded photo or file).
 *
 * @module
 */

export {
  canUseLauncher,
  createPortalLauncherRegistry,
  describeRunAsUser,
  PortalLauncherError,
  type PortalLauncherRegistry,
  type PortalLauncherRegistryDeps,
  type PortalLauncherViewer,
} from "./launchers";
export type { PortalApi, PortalLauncherDef, PortalLauncherProvider } from "./types";
