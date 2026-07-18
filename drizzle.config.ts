import { join, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

function resolveWorkDir(): string {
  const raw = process.env.AGENT_WORK_DIR || ".work";
  if (raw.startsWith("~/")) {
    return join(process.env.HOME!, raw.slice(2));
  }
  return resolve(raw);
}

function resolveDataDir(): string {
  if (process.env.DATA_DIR) {
    return resolve(process.env.DATA_DIR);
  }
  return join(resolveWorkDir(), ".palim");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: join(resolveDataDir(), "palim.db"),
  },
});
