/**
 * Extract a human-readable error message from a failed API response.
 * Prefers the `error` field of a JSON body and falls back to the HTTP status.
 *
 * @param res - The non-OK response
 * @returns The error message
 */
export async function responseError(res: Response): Promise<string> {
  const data = await res.json().catch(() => null);
  return typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
}

/**
 * Throw when a response is not OK, using {@link responseError} as the message.
 *
 * @param res - The response to check
 * @returns The same response, for chaining
 * @throws {Error} When `res.ok` is false
 */
export async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(await responseError(res));
  return res;
}
