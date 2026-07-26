/**
 * @file security/__tests__/security.test.ts
 * Focused tests on the most security-critical code path: relay payload
 * verification. These tests exist because a regression here would mean
 * "outside users can log into the terminal" — the single hardest
 * requirement in the spec.
 */

import { describe, it, expect } from "vitest";
import {
  mintSessionToken,
  verifyPayload,
  RelaySecurityError,
  redact,
  sanitiseMessage,
  sanitiseData,
  SESSION_MAX_AGE_MS,
} from "../index";
import type { LogEntry } from "../../core/types";

const SECRET = "test-secret-at-least-32-characters-long!!";
const ALLOWED_ORIGINS = ["https://example.com"];

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: "info",
    message: "hello world",
    context: {
      runtime: "client",
      timestamp: new Date().toISOString(),
      sequence: 0,
    },
    ...overrides,
  };
}

describe("verifyPayload", () => {
  it("accepts a request carrying a freshly minted, valid session token", async () => {
    const entries = [makeEntry()];
    const issuedAt = new Date().toISOString();
    const token = await mintSessionToken(SECRET, issuedAt);

    const result = await verifyPayload(
      { entries, token, issuedAt },
      JSON.stringify({ entries, token, issuedAt }).length,
      SECRET,
      ALLOWED_ORIGINS,
      "https://example.com",
      null,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe("hello world");
  });

  it("accepts the SAME token reused across multiple calls (bearer-token model, not per-payload HMAC)", async () => {
    const issuedAt = new Date().toISOString();
    const token = await mintSessionToken(SECRET, issuedAt);

    // Simulates what actually happens in production: one token minted at
    // page load, reused for every subsequent relay call (fetch retries,
    // beacon-on-unload) regardless of what entries each call carries.
    for (const entries of [[makeEntry({ message: "first" })], [makeEntry({ message: "second" })]]) {
      const result = await verifyPayload(
        { entries, token, issuedAt },
        100,
        SECRET,
        ALLOWED_ORIGINS,
        "https://example.com",
        null,
      );
      expect(result).toHaveLength(1);
    }
  });

  it("rejects a payload from a disallowed origin", async () => {
    const entries = [makeEntry()];
    const issuedAt = new Date().toISOString();
    const token = await mintSessionToken(SECRET, issuedAt);

    await expect(
      verifyPayload(
        { entries, token, issuedAt },
        100,
        SECRET,
        ALLOWED_ORIGINS,
        "https://evil.com",
        null,
      ),
    ).rejects.toThrow(RelaySecurityError);
  });

  it("rejects a token minted with the wrong secret", async () => {
    const entries = [makeEntry()];
    const issuedAt = new Date().toISOString();
    const forgedToken = await mintSessionToken(
      "wrong-secret-but-also-32-characters!!",
      issuedAt,
    );

    await expect(
      verifyPayload(
        { entries, token: forgedToken, issuedAt },
        100,
        SECRET,
        ALLOWED_ORIGINS,
        "https://example.com",
        null,
      ),
    ).rejects.toThrow(RelaySecurityError);
  });

  it("rejects a token whose claimed issuedAt doesn't match what it was signed over", async () => {
    const entries = [makeEntry()];
    const issuedAt = new Date().toISOString();
    const token = await mintSessionToken(SECRET, issuedAt);
    const tamperedIssuedAt = new Date(Date.now() - 1000).toISOString();

    await expect(
      verifyPayload(
        { entries, token, issuedAt: tamperedIssuedAt },
        100,
        SECRET,
        ALLOWED_ORIGINS,
        "https://example.com",
        null,
      ),
    ).rejects.toThrow(RelaySecurityError);
  });

  it("rejects a session token older than SESSION_MAX_AGE_MS", async () => {
    const entries = [makeEntry()];
    const staleIssuedAt = new Date(Date.now() - SESSION_MAX_AGE_MS - 60_000).toISOString();
    const token = await mintSessionToken(SECRET, staleIssuedAt);

    await expect(
      verifyPayload(
        { entries, token, issuedAt: staleIssuedAt },
        100,
        SECRET,
        ALLOWED_ORIGINS,
        "https://example.com",
        null,
      ),
    ).rejects.toThrow(RelaySecurityError);
  });

  it("rejects an issuedAt implausibly far in the future", async () => {
    const entries = [makeEntry()];
    const futureIssuedAt = new Date(Date.now() + 60_000).toISOString();
    const token = await mintSessionToken(SECRET, futureIssuedAt);

    await expect(
      verifyPayload(
        { entries, token, issuedAt: futureIssuedAt },
        100,
        SECRET,
        ALLOWED_ORIGINS,
        "https://example.com",
        null,
      ),
    ).rejects.toThrow(RelaySecurityError);
  });

  it("rejects an oversized payload before token verification", async () => {
    const entries = [makeEntry()];
    const issuedAt = new Date().toISOString();
    const token = await mintSessionToken(SECRET, issuedAt);

    await expect(
      verifyPayload(
        { entries, token, issuedAt },
        500_000, // exceeds 256KB cap
        SECRET,
        ALLOWED_ORIGINS,
        "https://example.com",
        null,
      ),
    ).rejects.toThrow(RelaySecurityError);
  });

  it("rejects a payload with too many entries", async () => {
    const entries = Array.from({ length: 200 }, () => makeEntry());
    const issuedAt = new Date().toISOString();
    const token = await mintSessionToken(SECRET, issuedAt);

    await expect(
      verifyPayload(
        { entries, token, issuedAt },
        100,
        SECRET,
        ALLOWED_ORIGINS,
        "https://example.com",
        null,
      ),
    ).rejects.toThrow(RelaySecurityError);
  });

  it("rejects malformed entry structures even if the token is valid", async () => {
    const badEntries = [
      { level: "not-a-real-level", message: 123 },
    ] as unknown as LogEntry[];
    const issuedAt = new Date().toISOString();
    const token = await mintSessionToken(SECRET, issuedAt);

    await expect(
      verifyPayload(
        { entries: badEntries, token, issuedAt },
        100,
        SECRET,
        ALLOWED_ORIGINS,
        "https://example.com",
        null,
      ),
    ).rejects.toThrow(RelaySecurityError);
  });

  it("rejects a payload missing required envelope fields", async () => {
    await expect(
      verifyPayload(
        { entries: [makeEntry()] }, // missing token & issuedAt
        100,
        SECRET,
        ALLOWED_ORIGINS,
        "https://example.com",
        null,
      ),
    ).rejects.toThrow(RelaySecurityError);
  });
});

describe("sanitiseMessage / sanitiseData (log injection)", () => {
  it("strips ANSI escape sequences from messages", () => {
    const malicious = "\x1b[31mFAKE ERROR\x1b[0m Real message";
    expect(sanitiseMessage(malicious)).not.toContain("\x1b");
  });

  it("caps message length to prevent terminal flooding", () => {
    const huge = "a".repeat(10_000);
    expect(sanitiseMessage(huge).length).toBeLessThanOrEqual(4096);
  });

  it("rejects circular references gracefully instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sanitiseData(circular)).not.toThrow();
  });
});

describe("redact", () => {
  it("replaces the value of a matching top-level key", () => {
    const out = redact({ password: "hunter2", user: "alice" }, ["password"]) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
    expect(out.user).toBe("alice");
  });

  it("matches keys case-insensitively", () => {
    const out = redact({ Password: "hunter2" }, ["password"]) as Record<string, unknown>;
    expect(out.Password).toBe("[REDACTED]");
  });

  it("redacts nested keys at any depth, including inside arrays", () => {
    const out = redact(
      { user: { credentials: { token: "abc123" } }, list: [{ secret: "x" }] },
      ["token", "secret"],
    ) as any;
    expect(out.user.credentials.token).toBe("[REDACTED]");
    expect(out.list[0].secret).toBe("[REDACTED]");
  });

  it("supports RegExp patterns", () => {
    const out = redact({ apiToken: "abc", authToken: "xyz", name: "ok" }, [/token$/i]) as Record<string, unknown>;
    expect(out.apiToken).toBe("[REDACTED]");
    expect(out.authToken).toBe("[REDACTED]");
    expect(out.name).toBe("ok");
  });

  it("is a no-op when no patterns are given", () => {
    const data = { password: "hunter2" };
    expect(redact(data, [])).toEqual(data);
  });
});
