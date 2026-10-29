/**
 * Portal workflow launchers: workflows with a `portal` trigger that portal
 * users start from the portal (typically with an uploaded photo or file).
 *
 * @module
 */

export {
  createPortalLauncherRegistry,
  describeRunAsUser,
  PortalLauncherError,
  type PortalLauncherRegistry,
  type PortalLauncherViewer,
} from "./launchers";
export type { PortalLauncherDef } from "./types";
