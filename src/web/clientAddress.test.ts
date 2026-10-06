import { describe, expect, test } from "bun:test";
import { clientAddress, createTrustedProxies } from "./auth";

/** A fake Bun server whose TCP peer is `peer`. */
const serverFrom = (peer: string) => ({ requestIP: () => ({ address: peer, family: "IPv4", port: 1 }) }) as never;

/** A request carrying the given X-Forwarded-For header (if any). */
const req = (xff?: string) =>
  new Request("http://localhost/api/x", { headers: xff === undefined ? {} : { "x-forwarded-for": xff } });

describe("clientAddress", () => {
  const trusted = createTrustedProxies(["127.0.0.1", "::1", "172.16.0.0/12"]);

  test("uses the peer when no proxies are trusted, ignoring the header", () => {
    expect(clientAddress(req("1.2.3.4"), serverFrom("203.0.113.9"), createTrustedProxies([]))).toBe("203.0.113.9");
  });

  test("ignores a forged header from an untrusted peer", () => {
    expect(clientAddress(req("1.2.3.4"), serverFrom("203.0.113.9"), trusted)).toBe("203.0.113.9");
  });

  test("uses the forwarded client behind a trusted proxy", () => {
    expect(clientAddress(req("198.51.100.7"), serverFrom("127.0.0.1"), trusted)).toBe("198.51.100.7");
  });

  test("skips client-supplied entries left of the first untrusted hop", () => {
    // Client sent "X-Forwarded-For: 1.2.3.4"; the proxy appended the real peer.
    expect(clientAddress(req("1.2.3.4, 198.51.100.7"), serverFrom("127.0.0.1"), trusted)).toBe("198.51.100.7");
  });

  test("walks past a chain of trusted proxies (CIDR and IPv6)", () => {
    expect(clientAddress(req("198.51.100.7, 172.18.0.5, ::1"), serverFrom("::1"), trusted)).toBe("198.51.100.7");
  });

  test("matches IPv4-mapped IPv6 peers", () => {
    expect(clientAddress(req("198.51.100.7"), serverFrom("::ffff:127.0.0.1"), trusted)).toBe("198.51.100.7");
  });

  test("falls back to the proxy when it sent no header", () => {
    expect(clientAddress(req(), serverFrom("127.0.0.1"), trusted)).toBe("127.0.0.1");
  });

  test("returns the leftmost hop when every hop is trusted", () => {
    expect(clientAddress(req("172.20.0.2, 172.18.0.5"), serverFrom("127.0.0.1"), trusted)).toBe("172.20.0.2");
  });

  test("returns unknown without a server", () => {
    expect(clientAddress(req("1.2.3.4"), undefined, trusted)).toBe("unknown");
  });
});
