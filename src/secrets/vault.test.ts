import { describe, expect, test } from "bun:test";
import { EncryptionService } from "./vault";

describe("EncryptionService", () => {
  describe("create", () => {
    test("succeeds with a 32-byte key", async () => {
      const key = Buffer.alloc(32, 0xab);
      const service = await EncryptionService.create(key);
      expect(service).not.toBeNull();
    });

    test("succeeds with a key longer than 32 bytes", async () => {
      const key = Buffer.alloc(64, 0xcd);
      const service = await EncryptionService.create(key);
      expect(service).not.toBeNull();
    });

    test("throws for a key shorter than 32 bytes", async () => {
      const key = Buffer.alloc(16, 0xab);
      expect(EncryptionService.create(key)).rejects.toThrow("Master key must be at least 32 bytes");
    });

    test("throws for an empty key", async () => {
      const key = Buffer.alloc(0);
      expect(EncryptionService.create(key)).rejects.toThrow("Master key must be at least 32 bytes");
    });
  });

  describe("encrypt", () => {
    test("returns base64-encoded iv and encryptedValue", async () => {
      const key = Buffer.alloc(32, 0xab);
      const service = await EncryptionService.create(key);

      const result = await service.encrypt("hello world");
      expect(result.iv).toBeTruthy();
      expect(result.encryptedValue).toBeTruthy();

      // Verify base64 decodability
      const ivBytes = Buffer.from(result.iv, "base64");
      expect(ivBytes.length).toBe(12);

      const cipherBytes = Buffer.from(result.encryptedValue, "base64");
      // ciphertext should be longer than plaintext (includes 16-byte auth tag)
      expect(cipherBytes.length).toBeGreaterThan("hello world".length);
    });

    test("produces different IVs for the same plaintext", async () => {
      const key = Buffer.alloc(32, 0xab);
      const service = await EncryptionService.create(key);

      const result1 = await service.encrypt("same text");
      const result2 = await service.encrypt("same text");

      expect(result1.iv).not.toBe(result2.iv);
    });
  });

  describe("decrypt", () => {
    test("round-trips plaintext correctly", async () => {
      const key = Buffer.alloc(32, 0xab);
      const service = await EncryptionService.create(key);

      const plaintext = "secret-api-key-12345";
      const encrypted = await service.encrypt(plaintext);
      const decrypted = await service.decrypt(encrypted.iv, encrypted.encryptedValue);

      expect(decrypted).toBe(plaintext);
    });

    test("handles unicode text", async () => {
      const key = Buffer.alloc(32, 0xab);
      const service = await EncryptionService.create(key);

      const plaintext = "Geheimer Schluessel mit Umlauten: ae oe ue";
      const encrypted = await service.encrypt(plaintext);
      const decrypted = await service.decrypt(encrypted.iv, encrypted.encryptedValue);

      expect(decrypted).toBe(plaintext);
    });

    test("handles empty string", async () => {
      const key = Buffer.alloc(32, 0xab);
      const service = await EncryptionService.create(key);

      const plaintext = "";
      const encrypted = await service.encrypt(plaintext);
      const decrypted = await service.decrypt(encrypted.iv, encrypted.encryptedValue);

      expect(decrypted).toBe(plaintext);
    });

    test("returns null for corrupted ciphertext", async () => {
      const key = Buffer.alloc(32, 0xab);
      const service = await EncryptionService.create(key);

      const fakeIv = Buffer.alloc(12, 0x01).toString("base64");
      const fakeData = Buffer.alloc(48, 0xff).toString("base64");

      const result = await service.decrypt(fakeIv, fakeData);
      expect(result).toBeNull();
    });

    test("returns null for tampered ciphertext", async () => {
      const key = Buffer.alloc(32, 0xab);
      const service = await EncryptionService.create(key);

      const encrypted = await service.encrypt("real secret");
      // Tamper with the ciphertext
      const tampered = Buffer.from(encrypted.encryptedValue, "base64");
      tampered[0] = tampered[0]! ^ 0xff;
      const tamperedB64 = tampered.toString("base64");

      const result = await service.decrypt(encrypted.iv, tamperedB64);
      expect(result).toBeNull();
    });

    test("returns null when wrong key is used for decryption", async () => {
      const key1 = Buffer.alloc(32, 0xab);
      const key2 = Buffer.alloc(32, 0xcd);
      const service1 = await EncryptionService.create(key1);
      const service2 = await EncryptionService.create(key2);

      const encrypted = await service1.encrypt("secret value");
      const result = await service2.decrypt(encrypted.iv, encrypted.encryptedValue);
      expect(result).toBeNull();
    });
  });
});

import fc from "fast-check";

/**
 * Property-based tests for EncryptionService.
 *
 * Validates: Requirements 3.1, 3.4, 3.7, 3.8
 */
describe("EncryptionService (property-based)", () => {
  test("Feature: web-secret-management, Property 1: Encryption round-trip", async () => {
    const key = Buffer.alloc(32, 0xab);
    const service = await EncryptionService.create(key);

    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 4096, unit: "grapheme-ascii" })
          .chain((s) => fc.constant(s).filter((v) => v.length >= 1)),
        async (plaintext) => {
          const encrypted = await service.encrypt(plaintext);
          const decrypted = await service.decrypt(encrypted.iv, encrypted.encryptedValue);
          expect(decrypted).toBe(plaintext);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 1: Encryption round-trip (unicode)", async () => {
    const key = Buffer.alloc(32, 0xab);
    const service = await EncryptionService.create(key);

    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 4096, unit: "grapheme" }), async (plaintext) => {
        const encrypted = await service.encrypt(plaintext);
        const decrypted = await service.decrypt(encrypted.iv, encrypted.encryptedValue);
        expect(decrypted).toBe(plaintext);
      }),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 2: Unique IV per encryption", async () => {
    const key = Buffer.alloc(32, 0xab);
    const service = await EncryptionService.create(key);
    const N = 10;

    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 256 }), async (plaintext) => {
        const results = await Promise.all(Array.from({ length: N }, () => service.encrypt(plaintext)));
        const ivs = results.map((r) => r.iv);
        const uniqueIvs = new Set(ivs);
        expect(uniqueIvs.size).toBe(N);
      }),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 3: Corrupted ciphertext returns null", async () => {
    const key = Buffer.alloc(32, 0xab);
    const service = await EncryptionService.create(key);

    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 12, maxLength: 12 }),
        fc.uint8Array({ minLength: 16, maxLength: 128 }),
        async (ivBytes, cipherBytes) => {
          const iv = Buffer.from(ivBytes).toString("base64");
          const encryptedValue = Buffer.from(cipherBytes).toString("base64");
          const result = await service.decrypt(iv, encryptedValue);
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 4: Master key length validation", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 31 }), async (length) => {
        const shortKey = Buffer.alloc(length, 0xaa);
        expect(EncryptionService.create(shortKey)).rejects.toThrow();
      }),
      { numRuns: 100 },
    );

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 32, max: 64 }), async (length) => {
        const validKey = Buffer.alloc(length, 0xbb);
        const service = await EncryptionService.create(validKey);
        expect(service).not.toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@src/db/schema";
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { SecretVault } from "./vault";
import { secretsVault } from "./vaultSchema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../../drizzle");

function createTestDb(): BunSQLiteDatabase {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db as unknown as BunSQLiteDatabase;
}

/**
 * Property-based tests for SecretVault ACL enforcement.
 *
 * Validates: Requirements 4.2, 4.3, 4.8, 5.1, 5.5, 5.6
 */
describe("SecretVault (property-based)", () => {
  // Generators
  const scopeArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/);
  const keyArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,15}$/);
  const valueArb = fc.string({ minLength: 1, maxLength: 256 });

  /** Generate a valid consumer identity like "ext:name" or "workflow:name" */
  const consumerIdentityArb = fc.oneof(
    scopeArb.map((s) => `ext:${s}`),
    scopeArb.map((s) => `workflow:${s}`),
  );

  /** Generate a valid ACL pattern (exact, wildcard suffix, or global wildcard) */
  const aclPatternArb = fc.oneof(consumerIdentityArb, fc.constantFrom("ext:*", "workflow:*"), fc.constant("*"));

  test("Feature: web-secret-management, Property 7: ACL enforcement", async () => {
    const db = createTestDb();
    const masterKey = Buffer.alloc(32, 0xab);
    const vault = await SecretVault.create({ database: db, masterKey });

    await fc.assert(
      fc.asyncProperty(
        scopeArb,
        keyArb,
        valueArb,
        fc.array(aclPatternArb, { minLength: 1, maxLength: 5 }),
        consumerIdentityArb,
        async (scope, key, value, aclPatterns, consumer) => {
          // Store a secret with specific ACL patterns
          await vault.bulkUpsert(scope, { [key]: value }, aclPatterns);

          // The actual stored ACL includes the owner pattern `ext:{scope}` plus the provided patterns
          const ownerPattern = `ext:${scope}`;
          const effectiveAcl = [ownerPattern, ...aclPatterns.filter((p) => p !== ownerPattern)];

          // Check if consumer matches any pattern in effectiveAcl
          const shouldMatch = effectiveAcl.some((pattern) => {
            if (pattern === "*") return true;
            if (pattern === consumer) return true;
            if (pattern.endsWith(":*")) {
              const prefix = pattern.slice(0, -1);
              return consumer.startsWith(prefix);
            }
            return false;
          });

          const result = await vault.resolve(scope, key, consumer);

          if (shouldMatch) {
            expect(result.granted).toBe(true);
            expect(result.value).toBe(value);
          } else {
            expect(result.granted).toBe(false);
            expect(result.value).toBeNull();
            expect(result.reason).toBe("ACL denied");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 8: Owner pattern invariant", async () => {
    const db = createTestDb();
    const masterKey = Buffer.alloc(32, 0xab);
    const vault = await SecretVault.create({ database: db, masterKey });

    await fc.assert(
      fc.asyncProperty(
        scopeArb,
        keyArb,
        valueArb,
        fc.option(fc.array(aclPatternArb, { minLength: 0, maxLength: 5 }), { nil: undefined }),
        async (scope, key, value, consumers) => {
          // Call bulkUpsert with various consumer lists (including undefined/empty/excluding owner)
          await vault.bulkUpsert(scope, { [key]: value }, consumers);

          // Read the stored row directly from the database
          const row = db
            .select({ aclConsumers: secretsVault.aclConsumers })
            .from(secretsVault)
            .where(and(eq(secretsVault.scope, scope), eq(secretsVault.secretKey, key)))
            .get();

          expect(row).not.toBeNull();
          const storedAcl: string[] = JSON.parse(row!.aclConsumers);
          const ownerPattern = `ext:${scope}`;
          expect(storedAcl).toContain(ownerPattern);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 11: Missing key returns null", async () => {
    const db = createTestDb();
    const masterKey = Buffer.alloc(32, 0xab);
    const vault = await SecretVault.create({ database: db, masterKey });

    await fc.assert(
      fc.asyncProperty(scopeArb, keyArb, consumerIdentityArb, async (scope, key, consumer) => {
        // Do NOT store anything — just resolve a non-existent key
        const result = await vault.resolve(scope, key, consumer);

        expect(result.value).toBeNull();
        expect(result.granted).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
