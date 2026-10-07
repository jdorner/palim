import type { InputType } from "node:zlib";
import { type BrotliOptions, brotliCompressSync, constants, deflateSync, gzipSync, type ZlibOptions } from "node:zlib";
import { Elysia, type LifeCycleType } from "elysia";
import { ElysiaCustomStatusResponse } from "elysia/error";

export type CompressionType = "gzip" | "deflate" | "br";

/** Compressed payload, typed so it is a valid `BodyInit` under both Bun and DOM lib typings. */
type CompressedBody = Uint8Array<ArrayBuffer>;

/**
 * Re-types a zlib result as a `CompressedBody` without copying.
 * zlib allocates its output on a regular (non-shared) ArrayBuffer, so the cast is sound.
 * @param buf - Buffer returned by a node:zlib sync compressor
 * @returns A view over the same memory
 */
const toBody = (buf: Buffer): CompressedBody =>
  new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);

export interface CompressionOptions {
  /** Preferred compressors in priority order. First match with client's accept-encoding wins. */
  types?: CompressionType[];
  /** Minimum response size (in bytes) to compress. Responses smaller than this are sent uncompressed. Default: 1024 */
  threshold?: number;
  /** Brotli compression options. */
  brotliOptions?: BrotliOptions;
  /** Zlib options for gzip/deflate. */
  zlibOptions?: ZlibOptions;
  /** Cache configuration. Set to false to disable caching. */
  cache?: CompressionCacheOptions | false;
  /** Elysia lifecycle scope. Default: "global" */
  as?: LifeCycleType;
}

export interface CompressionCacheOptions {
  /** Maximum number of entries in the cache. Default: 256 */
  maxEntries?: number;
  /** Maximum response size (in bytes) eligible for caching. Default: 1MB */
  maxSize?: number;
}

const DEFAULT_TYPES: CompressionType[] = ["br", "gzip", "deflate"];
const DEFAULT_THRESHOLD = 1024;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_SIZE = 1024 * 1024;

/** Content types that should not be compressed (already compressed or binary). */
const INCOMPRESSIBLE_TYPES = /^(image|audio|video|font)\//;
const INCOMPRESSIBLE_SUFFIXES = ["woff", "woff2", "gz", "br", "zst", "zip", "rar", "7z", "webp", "avif", "mp4", "webm"];

/**
 * Returns true if the content-type indicates the response should not be compressed.
 */
function isIncompressible(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  if (INCOMPRESSIBLE_TYPES.test(contentType)) return true;
  for (const suffix of INCOMPRESSIBLE_SUFFIXES) {
    if (contentType.includes(suffix)) return true;
  }
  return false;
}

/**
 * Simple LRU cache for compressed buffers.
 * Key is derived from a hash of the raw content + compression type.
 */
class CompressionCache {
  private cache = new Map<string, CompressedBody>();
  private maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): CompressedBody | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  set(key: string, value: CompressedBody): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, value);
  }
}

/**
 * Elysia compression plugin supporting gzip, deflate, and brotli.
 *
 * Uses the `mapResponse` lifecycle hook to compress response bodies.
 * Includes an optional LRU cache to avoid recompressing identical payloads.
 */
export const compression = ({
  types = DEFAULT_TYPES,
  threshold = DEFAULT_THRESHOLD,
  brotliOptions,
  zlibOptions,
  cache: cacheOpts,
  as = "global",
}: CompressionOptions = {}) => {
  const encoder = new TextEncoder();

  const compressors: Record<string, ((input: InputType) => CompressedBody) | undefined> = {
    gzip: types.includes("gzip") ? (buf) => toBody(gzipSync(buf, zlibOptions)) : undefined,
    deflate: types.includes("deflate") ? (buf) => toBody(deflateSync(buf, zlibOptions)) : undefined,
    br: types.includes("br")
      ? (buf) =>
          toBody(
            brotliCompressSync(buf, {
              params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_DEFAULT_QUALITY },
              ...brotliOptions,
            }),
          )
      : undefined,
  };

  const cacheEnabled = cacheOpts !== false;
  const maxEntries = (cacheOpts && typeof cacheOpts === "object" && cacheOpts.maxEntries) || DEFAULT_MAX_ENTRIES;
  const maxSize = (cacheOpts && typeof cacheOpts === "object" && cacheOpts.maxSize) || DEFAULT_MAX_SIZE;
  const cache = cacheEnabled ? new CompressionCache(maxEntries) : null;

  return new Elysia().mapResponse({ as }, async ({ responseValue, set, headers }) => {
    // Skip empty, function, or null responses
    if (!responseValue || typeof responseValue === "function") return;

    let text: string;
    let contentType: string;

    // Track whether we consumed a Response body
    let responseBodyUsed = false;
    // Headers of a consumed Response, carried over to the replacement response
    let originalHeaders: Headers | undefined;

    if (responseValue instanceof Response) {
      const ct = responseValue.headers.get("content-type");
      // Skip binary/already-compressed content types
      if (isIncompressible(ct)) return;
      // Skip if already has content-encoding
      if (responseValue.headers.get("content-encoding")) return;
      // Skip redirects
      if (responseValue.status >= 300 && responseValue.status < 400) return;

      text = await responseValue.text();
      contentType = ct ?? "text/plain";
      set.status = responseValue.status;
      responseBodyUsed = true;
      originalHeaders = responseValue.headers;
    } else {
      // Unwrap ElysiaCustomStatusResponse (from status() helper)
      let value: unknown = responseValue;
      if (value instanceof ElysiaCustomStatusResponse) {
        set.status = value.code;
        value = value.response;
      }

      // After unwrapping, skip if empty or not serializable
      if (value === undefined || value === null) return;
      if (typeof value === "function") return;

      const isJson = typeof value === "object";
      text = isJson ? JSON.stringify(value) : (value?.toString() ?? "");
      contentType = `${isJson ? "application/json" : "text/plain"}; charset=utf-8`;
    }

    /** Builds the replacement response, keeping the original response's headers (cache-control, ...). */
    const respond = (body: string | CompressedBody) => {
      const responseHeaders = new Headers(originalHeaders);
      responseHeaders.delete("content-length");
      responseHeaders.set("Content-Type", contentType);
      return new Response(body, { headers: responseHeaders });
    };

    // Below threshold: return uncompressed (must return Response if body was consumed)
    if (text.length < threshold) {
      if (responseBodyUsed) {
        return respond(text);
      }
      return;
    }

    // Find the first accepted encoding that we support (in priority order)
    const acceptEncoding = headers["accept-encoding"] ?? "";
    let selectedType: CompressionType | undefined;
    for (const t of types) {
      if (acceptEncoding.includes(t)) {
        selectedType = t;
        break;
      }
    }
    if (!selectedType) {
      if (responseBodyUsed) {
        return respond(text);
      }
      return;
    }

    const compressor = compressors[selectedType];
    if (!compressor) {
      if (responseBodyUsed) {
        return respond(text);
      }
      return;
    }

    // Compress (with optional caching)
    const encoded = encoder.encode(text);
    let compressed: CompressedBody;

    if (cache && encoded.byteLength <= maxSize) {
      const cacheKey = `${selectedType}:${Bun.hash(encoded).toString(36)}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        compressed = cached;
      } else {
        compressed = compressor(encoded);
        cache.set(cacheKey, compressed);
      }
    } else {
      compressed = compressor(encoded);
    }

    // Set Content-Encoding on set.headers (Elysia merges these automatically)
    set.headers["Content-Encoding"] = selectedType;

    // Return a new Response with Content-Type (and the original headers) on the Response itself
    return respond(compressed);
  });
};
