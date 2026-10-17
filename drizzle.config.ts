import { join, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

function resolveDataDir(): string {
  const raw = process.env.DATA_DIR;
  if (!raw) return resolve(".palim");
  if (raw.startsWith("~/")) {
    return join(process.env.HOME!, raw.slice(2));
  }
  return resolve(raw);
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: join(resolveDataDir(), "palim.db"),
  },
});
