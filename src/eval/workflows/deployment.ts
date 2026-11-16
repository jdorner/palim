/**
 * A throwaway Palim deployment for one eval run.
 *
 * Starts the real server (`src/main.ts`) as a child process with a temporary
 * `AGENT_WORK_DIR` and `DATA_DIR` on a free port, and drives it through the
 * same HTTP and WebSocket API the web UI uses. Nothing of the server is
 * reimplemented here, so the agent sees exactly the skills, tools and
 * validation of a normal deployment.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChatWebSocketEvent } from "@shared/chat";
import { PROJECT_DIR } from "@src/config";

/** How one chat turn ended. */
export type ChatOutcome = "done" | "error" | "timeout";

/** Result of one chat turn. */
export interface ChatResult {
  /** Session of the chat; pass it to `chat` to continue the conversation. */
  sessionId: string;
  /** `done`: the agent finished; `error`: the job failed; `timeout`: no end within the limit. */
  outcome: ChatOutcome;
  /** The agent's final text (`done`) or the error message (`error`). */
  text: string;
  /** Id of the chat job, for fetching its log. */
  jobId: string;
}

/** A warning of the workflow analyzer. */
export interface AnalyzerWarning {
  stepSlug: string;
  field: string;
  message: string;
}

/** Options for {@link startEvalDeployment}. */
export interface EvalDeploymentOptions {
  /** Directory of this run; `work/`, `data/` and `server.log` are created in it. */
  runDir: string;
  /** Extensions to enable, by name. */
  extensions: readonly string[];
  /** Directory holding the installed external extensions to copy from; missing ones are skipped. */
  externalExtensionsDir: string;
  /** Model the chat agent runs on. */
  model: { id: string; reasoning: boolean };
}

/** A running eval deployment. */
export interface EvalDeployment {
  /** The deployment's `AGENT_WORK_DIR`. */
  workDir: string;
  /** Requested extensions that could not be enabled, with the reason. */
  skippedExtensions: { name: string; reason: string }[];
  /**
   * Sends one user message and waits for the agent to finish its turn.
   *
   * @param message - The user message
   * @param timeoutMs - How long to wait for the end of the turn
   * @param sessionId - Session of an earlier turn to continue; a new chat when omitted
   * @returns How the turn ended
   */
  chat(message: string, timeoutMs: number, sessionId?: string): Promise<ChatResult>;
  /**
   * Fetches the log lines of a job.
   *
   * @param jobId - The job id
   * @returns The log entries, or `null` when they cannot be fetched
   */
  jobLogs(jobId: string): Promise<unknown>;
  /**
   * Lists the step types the deployment offers (engine and extension-registered).
   *
   * @returns The config JSON Schema per step type (`undefined` when it declares none)
   * @throws When the request fails
   */
  stepTypes(): Promise<Map<string, unknown>>;
  /**
   * Runs the server's authoritative validation on a definition.
   *
   * @param definition - The parsed workflow definition
   * @returns The validation errors (empty when valid)
   * @throws When the request fails
   */
  validate(definition: unknown): Promise<string[]>;
  /**
   * Asks the workflow analyzer for its advisory warnings.
   *
   * @param definition - The parsed workflow definition
   * @returns The warnings
   * @throws When the request fails
   */
  analyze(definition: unknown): Promise<AnalyzerWarning[]>;
  /** Stops the server. Safe to call more than once. */
  stop(): Promise<void>;
}

/** How long the server may take to answer `/health` after spawn. */
const BOOT_TIMEOUT_MS = 180_000;

/**
 * Finds a TCP port that is free right now.
 *
 * @returns The port number
 */
function findFreePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Could not find a free port");
  return port;
}

/**
 * Starts a fresh Palim server for one eval run and prepares it: logs in as
 * the seeded admin, enables the requested extensions and selects the model.
 *
 * @param options - Run directory, extensions and model
 * @returns The running deployment; call `stop()` when done
 * @throws When the server does not come up, the login fails, or the model cannot be selected
 */
export async function startEvalDeployment(options: EvalDeploymentOptions): Promise<EvalDeployment> {
  const { runDir, extensions, externalExtensionsDir, model } = options;
  const workDir = join(runDir, "work");
  const dataDir = join(runDir, "data");
  await mkdir(workDir, { recursive: true });
  await mkdir(join(dataDir, "extensions"), { recursive: true });

  // External extensions are copied, never linked: the server installs
  // dependencies and writes a tsconfig into each extension directory.
  for (const name of extensions) {
    const source = join(externalExtensionsDir, name);
    if (await Bun.file(join(source, "index.ts")).exists()) {
      await cp(source, join(dataDir, "extensions", name), { recursive: true });
    }
  }

  const port = findFreePort();
  const origin = `http://localhost:${port}`;
  const adminPassword = randomBytes(24).toString("hex");
  const env: Record<string, string | undefined> = {
    ...process.env,
    AGENT_WORK_DIR: workDir,
    DATA_DIR: dataDir,
    WEB_SCHEME: "http",
    WEB_HOST: "localhost",
    WEB_PORT: String(port),
    AUTH_ADMIN_USER: "admin",
    AUTH_ADMIN_PASSWORD: adminPassword,
    HITL_ENABLED: "true",
  };
  // Set by the parent's boot code or .env for the real deployment; the child derives its own.
  delete env.DATA_PATH;
  delete env.WEB_PUBLIC_URL;

  const logFile = Bun.file(join(runDir, "server.log"));
  const server = Bun.spawn(["bun", "src/main.ts"], {
    cwd: PROJECT_DIR,
    env,
    stdin: "ignore",
    stdout: logFile,
    stderr: logFile,
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    server.kill("SIGTERM");
    const killTimer = setTimeout(() => server.kill("SIGKILL"), 15_000);
    await server.exited;
    clearTimeout(killTimer);
  };

  try {
    const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`Eval server exited during boot (see ${logFile.name})`);
      const up = await fetch(`${origin}/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (up) break;
      if (Date.now() > bootDeadline) throw new Error(`Eval server did not start in time (see ${logFile.name})`);
      await Bun.sleep(500);
    }

    const loginResp = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: adminPassword }),
    });
    if (!loginResp.ok) throw new Error(`Eval server login failed: ${loginResp.status}`);
    const { token } = (await loginResp.json()) as { token: string };

    const api = (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${origin}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });

    /** Fetches JSON and throws on a non-2xx status. */
    const apiJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const resp = await api(path, init);
      if (!resp.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${resp.status} ${await resp.text()}`);
      return (await resp.json()) as T;
    };

    // Extensions without a settings row start disabled, so enable each one.
    const skippedExtensions: { name: string; reason: string }[] = [];
    const loaded = await apiJson<{ name: string; enabled: boolean }[]>("/api/extensions");
    for (const name of extensions) {
      const info = loaded.find((e) => e.name === name);
      if (!info) {
        skippedExtensions.push({ name, reason: "not installed" });
        continue;
      }
      if (info.enabled) continue;
      const resp = await api(`/api/extensions/${name}`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
      if (!resp.ok) skippedExtensions.push({ name, reason: (await resp.text()).slice(0, 200) });
    }

    await apiJson("/api/models"); // fills the model cache the selection is checked against
    await apiJson("/api/models/selected", {
      method: "PUT",
      body: JSON.stringify({ modelId: model.id, reasoning: model.reasoning }),
    });

    const chat = async (message: string, timeoutMs: number, sessionId?: string): Promise<ChatResult> => {
      const chatId = `eval-${randomBytes(6).toString("hex")}`;
      // Same handshake as the web UI: the token travels as a subprotocol.
      const ws = new WebSocket(`ws://localhost:${port}/ws`, [`auth-${token}`]);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
        });

        type Ending = Pick<ChatResult, "outcome" | "text">;
        const ended = new Promise<Ending>((resolve) => {
          const timer = setTimeout(() => resolve({ outcome: "timeout", text: "" }), timeoutMs);
          const finish = (result: Ending) => {
            clearTimeout(timer);
            resolve(result);
          };
          ws.addEventListener("message", (raw) => {
            let event: Partial<ChatWebSocketEvent>;
            try {
              event = JSON.parse(String(raw.data));
            } catch {
              return;
            }
            if (event.type !== "chat_event" || event.chatId !== chatId) return;
            if (event.event === "done") finish({ outcome: "done", text: event.content ?? "" });
            if (event.event === "error") finish({ outcome: "error", text: event.error ?? "" });
          });
          ws.addEventListener("close", () => finish({ outcome: "error", text: "WebSocket closed" }));
        });

        const enqueued = await apiJson<{ jobId: string; sessionId: string }>("/api/chat", {
          method: "POST",
          body: JSON.stringify({ message, chatId, ...(sessionId ? { sessionId } : {}) }),
        });
        return { ...(await ended), ...enqueued };
      } finally {
        ws.close();
      }
    };

    return {
      workDir,
      skippedExtensions,
      chat,
      jobLogs: (jobId) =>
        api(`/api/jobs/${jobId}/logs`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      stepTypes: async () =>
        new Map(
          (await apiJson<{ type: string; configSchema?: unknown }[]>("/ext/workflows/meta/step-types")).map((t) => [
            t.type,
            t.configSchema,
          ]),
        ),
      validate: async (definition) =>
        (
          await apiJson<{ errors?: string[] }>("/ext/workflows/meta/validate", {
            method: "POST",
            body: JSON.stringify(definition),
          })
        ).errors ?? [],
      analyze: async (definition) =>
        (
          await apiJson<{ warnings?: AnalyzerWarning[] }>("/ext/workflows/meta/analyze", {
            method: "POST",
            body: JSON.stringify(definition),
          })
        ).warnings ?? [],
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
