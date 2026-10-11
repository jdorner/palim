import path from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/** The operator UI's lib: home of the reused `@palim/ui` kit, which imports `$lib/...` itself. */
const FRONTEND_LIB = path.resolve(import.meta.dirname, "../frontend/src/lib");

export default defineConfig({
  // Relative asset URLs, so the build works under any path (Palim serves it at /portal/).
  base: "./",
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      // `$app`: the portal's own modules. `$lib` keeps meaning the operator UI's
      // lib so the reused kit sources resolve their own imports.
      $app: path.resolve(import.meta.dirname, "src/lib"),
      $lib: FRONTEND_LIB,
      $shared: path.resolve(import.meta.dirname, "../shared"),
      "@palim/ui": path.join(FRONTEND_LIB, "extensionKit.ts"),
    },
    // Kit sources import svelte/bits-ui from frontend/node_modules; one copy only.
    dedupe: ["svelte", "bits-ui", "phosphor-svelte", "clsx", "tailwind-merge", "tailwind-variants"],
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  publicDir: "static",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
