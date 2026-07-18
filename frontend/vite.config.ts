import path from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    svelte({
      compilerOptions: {
        hmr: true,
        dev: true,
      },
    }),
  ],
  resolve: {
    alias: {
      $lib: path.resolve("./src/lib"),
      $shared: path.resolve("../shared"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:3000",
        ws: true,
      },
      "/api": "http://127.0.0.1:3000",
      "/ext": "http://127.0.0.1:3000",
    },
  },
  publicDir: "static",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
