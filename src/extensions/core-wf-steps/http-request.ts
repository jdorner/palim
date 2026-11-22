/**
 * HTTP Request step type handler.
 *
 * Makes outbound HTTP requests with support for:
 * - Configurable HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD)
 * - Custom headers (key-value pairs, supports template expressions)
 * - Request body with template resolution
 * - Configurable timeout
 * - Response format selection (json or text)
 * - Expected status code validation
 *
 * When `responseFormat` is `"json"`, the response body is parsed and returned
 * as a structured object, enabling downstream steps to access fields via
 * `{{steps.<slug>.result.<path>}}` expressions.
 */

import { formatValidationErrors } from "@ext/sdk";
import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** TypeBox schema for the http-request step configuration. */
const HttpRequestStepConfigSchema = Type.Object({
  url: Type.String({
    title: "URL",
    description: "Request URL. Supports {{template}} expressions.",
    minLength: 1,
  }),
  method: Type.Optional(
    Type.Union(
      [
        Type.Literal("GET"),
        Type.Literal("POST"),
        Type.Literal("PUT"),
        Type.Literal("PATCH"),
        Type.Literal("DELETE"),
        Type.Literal("HEAD"),
      ],
      {
        title: "Method",
        description: "HTTP method to use.",
        default: "POST",
      },
    ),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      title: "Headers",
      description: "Custom request headers (key-value). Values support {{template}} expressions.",
    }),
  ),
  body: Type.Optional(
    Type.String({
      title: "Body",
      description: "Request body. Supports {{template}} expressions.",
      multiline: true,
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      title: "Timeout (ms)",
      description: "Request timeout in milliseconds. Default: 30000.",
      default: 30000,
      minimum: 1000,
      maximum: 300000,
    }),
  ),
  responseFormat: Type.Optional(
    Type.Union([Type.Literal("json"), Type.Literal("text")], {
      title: "Response Format",
      description: "How to parse the response. 'json' enables dot-path access in downstream steps.",
      default: "text",
    }),
  ),
  expectedStatus: Type.Optional(
    Type.Array(Type.Number(), {
      title: "Expected Status Codes",
      description: "Acceptable HTTP status codes. If empty, any 2xx is accepted.",
    }),
  ),
});

/** Result shape returned by the http-request step. */
interface HttpRequestResult {
  /** HTTP status code of the response. */
  status: number;
  /** Response body (string or parsed JSON depending on responseFormat). */
  body: unknown;
}

/**
 * Creates the HTTP Request step type handler.
 *
 * @returns A {@link StepTypeHandler} for the `http-request` step type
 */
export function createHttpRequestHandler(): StepTypeHandler {
  return {
    schema: HttpRequestStepConfigSchema,
    outputSchema: Type.Object({
      status: Type.Number({ description: "HTTP status code of the response." }),
      body: Type.Unknown({
        description: "Response body (parsed JSON when responseFormat is 'json', else text).",
      }),
    }),
    label: "HTTP Request",
    description: "Sends an HTTP request and returns the response status and body.",
    icon: "GlobeIcon",

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<HttpRequestResult> {
      const { slug: _slug, type: _type, outputSchema: _os, ...configFields } = stepDef;

      if (!Value.Check(HttpRequestStepConfigSchema, configFields)) {
        const errorMsg = formatValidationErrors(HttpRequestStepConfigSchema, configFields);
        throw new Error(`Invalid http-request step configuration: ${errorMsg}`);
      }

      const config = configFields as {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        timeout?: number;
        responseFormat?: string;
        expectedStatus?: number[];
      };

      // Resolve template expressions in the URL
      const { resolved: url, warnings: urlWarnings } = await ctx.resolveTemplate(config.url);
      for (const w of urlWarnings) {
        await ctx.jobLog(`Warning (url): ${w}`);
      }

      const method = config.method ?? "POST";
      const timeout = config.timeout ?? 30000;
      const responseFormat = config.responseFormat ?? "text";

      // Resolve headers with template expressions
      const headers: Record<string, string> = {};
      if (config.headers) {
        for (const [key, value] of Object.entries(config.headers)) {
          const { resolved } = await ctx.resolveTemplate(value);
          headers[key] = resolved;
        }
      }

      // Default Content-Type for requests with a body
      if (config.body && !headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }

      // Resolve body template
      let body: string | undefined;
      if (config.body) {
        const { resolved, warnings } = await ctx.resolveTemplate(config.body);
        for (const w of warnings) {
          await ctx.jobLog(`Warning (body): ${w}`);
        }
        body = resolved;
      }

      await ctx.jobLog(`${method} ${url}`);

      // Execute the request with timeout; cancelling the step aborts it too.
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
      const abortReason = (err: unknown): unknown => {
        if (ctx.signal?.aborted) return ctx.signal.reason;
        if (timeoutSignal.aborted) return new Error(`HTTP request timed out after ${timeout}ms`);
        return err;
      };

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: method !== "GET" && method !== "HEAD" ? body : undefined,
          signal,
        });
      } catch (err) {
        throw abortReason(err);
      }

      /** Reads the response body, mapping a cancel or timeout like the request itself. */
      const readText = (): Promise<string> => response.text().catch((err: unknown) => Promise.reject(abortReason(err)));

      // Validate status code
      const expectedStatuses = config.expectedStatus;
      if (expectedStatuses && expectedStatuses.length > 0) {
        if (!expectedStatuses.includes(response.status)) {
          const text = await readText();
          throw new Error(
            `HTTP ${response.status} ${response.statusText} (expected ${expectedStatuses.join("|")}): ${text}`,
          );
        }
      } else if (!response.ok) {
        const text = await readText();
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
      }

      // Parse response
      const responseText = await readText();
      let responseBody: unknown = responseText;

      if (responseFormat === "json") {
        try {
          responseBody = JSON.parse(responseText);
        } catch {
          await ctx.jobLog("Warning: responseFormat is 'json' but response is not valid JSON, returning as text");
        }
      }

      await ctx.jobLog(`Response: ${response.status} ${response.statusText}`);

      return { status: response.status, body: responseBody };
    },
  };
}
