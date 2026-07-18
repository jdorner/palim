/**
 * Secret vault initialization utilities.
 *
 * Extracted from boot.ts to isolate crypto key derivation and vault
 * setup into a testable, focused module.
 *
 * @module
 */

import { join } from "node:path";
import { PROJECT_DIR } from "@src/config";
import { mainLogger as log } from "@src/utils/logger";

/**
 * Derives the master key for the SecretVault from environment or `.env.keys` file.
 *
 * Precedence:
 * 1. `SECRETS_MASTER_KEY` env var (hex or base64 decoded, must be >= 32 bytes)
 * 2. `.env.keys` file content derived via HKDF-SHA256
 * 3. Returns undefined if neither source is available
 *
 * @returns A Buffer containing the 32-byte master key, or undefined if no key source is available
 */
export async function deriveMasterKey(): Promise<Buffer | undefined> {
  // 1. Check SECRETS_MASTER_KEY environment variable
  const envKey = process.env.SECRETS_MASTER_KEY;
  if (envKey) {
    let decoded: Buffer;

    // Try hex first, then base64
    if (/^[0-9a-fA-F]+$/.test(envKey)) {
      decoded = Buffer.from(envKey, "hex");
    } else {
      decoded = Buffer.from(envKey, "base64");
    }

    if (decoded.length < 32) {
      log.error(`SECRETS_MASTER_KEY is too short: ${decoded.length} bytes (need >= 32)`);
      return undefined;
    }

    return decoded.subarray(0, 32);
  }

  // 2. Check .env.keys file
  const envKeysPath = join(PROJECT_DIR, ".env.keys");
  const envKeysFile = Bun.file(envKeysPath);

  if (await envKeysFile.exists()) {
    const rawContent = await envKeysFile.text();

    // Derive key via HKDF-SHA256
    const ikm = new TextEncoder().encode(rawContent);
    const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: new TextEncoder().encode("palim-secret-vault-v1"),
      },
      baseKey,
      256, // 32 bytes
    );

    return Buffer.from(derivedBits);
  }

  // 3. No key source available
  return undefined;
}
