/**
 * Minimal hash router (`#/tasks/abc`). Hash routes work wherever the portal is
 * hosted (any base path, static hosting) without server rewrites.
 *
 * @module
 */

/** Reads the current route path from the location hash. */
function currentPath(): string {
  const hash = location.hash.replace(/^#/, "");
  return hash.startsWith("/") ? hash : "/";
}

/** Reactive router state. */
class Router {
  /** The current path (e.g. "/tasks/abc"). */
  path = $state(currentPath());

  constructor() {
    window.addEventListener("hashchange", () => {
      this.path = currentPath();
    });
  }

  /**
   * Navigates to a path.
   *
   * @param path - Target path (e.g. "/tasks")
   * @param replace - Replace the history entry instead of pushing one
   */
  navigate(path: string, replace = false): void {
    if (replace) {
      history.replaceState(null, "", `#${path}`);
      this.path = path;
    } else {
      location.hash = path;
    }
  }
}

/** The app router. */
export const router = new Router();

export { matchRoute } from "./routeMatch";
