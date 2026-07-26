/**
 * @file core/__tests__/logger.test.ts
 * Regression tests for two bugs that a single test each would have caught:
 *
 *  - `createLogger()` overrides (minLevel, sampleRate, ...) were silently
 *    discarded because `dispatch()` read a module-level `config` variable
 *    that had already been restored by the time the returned logger's
 *    methods were actually called.
 *  - Per-level sampling didn't exist at all; these tests double as its spec.
 *
 * Uses the `transports` hook (a first-class config option, see
 * core/types.ts) as the observation point instead of spying on
 * `process.stdout.write` — cleaner than mocking a Node stream, and it's
 * a real public feature so this doubles as its test.
 */

import { describe, it, expect } from "vitest";
import { createLogger, configureLogger, log } from "../logger";
import type { LogEntry } from "../../core/types";

function captureTransport() {
  const entries: LogEntry[] = [];
  const transport = (entry: LogEntry) => entries.push(entry);
  return { entries, transports: [transport] };
}

describe("createLogger — per-instance config isolation", () => {
  it("applies its own minLevel independently of the global default", () => {
    const cap = captureTransport();
    const quiet = createLogger({ minLevel: "error", transports: cap.transports });

    quiet.debug("should be filtered out");
    quiet.info("should also be filtered out");
    expect(cap.entries).toHaveLength(0);

    quiet.error("should pass through");
    expect(cap.entries).toHaveLength(1);
    expect(cap.entries[0]?.message).toBe("should pass through");
  });

  it("is unaffected by a later configureLogger() call, and vice versa", () => {
    const cap = captureTransport();
    const isolated = createLogger({ minLevel: "fatal", namespace: "isolated", transports: cap.transports });

    // Bumping the global default's minLevel down to 'debug' must not loosen
    // (or otherwise touch) the already-created isolated instance.
    configureLogger({ minLevel: "debug" });

    isolated.error("still filtered — instance kept minLevel: fatal");
    expect(cap.entries).toHaveLength(0);

    isolated.fatal("passes — matches instance's own minLevel");
    expect(cap.entries).toHaveLength(1);

    configureLogger({}); // reset for other tests
  });

  it("configureLogger() DOES affect the default `log` singleton immediately", () => {
    const cap = captureTransport();
    configureLogger({ minLevel: "warn", transports: cap.transports });

    log.info("filtered under the new global minLevel");
    expect(cap.entries).toHaveLength(0);

    log.warn("passes");
    expect(cap.entries).toHaveLength(1);

    configureLogger({}); // reset to defaults for other tests
  });

  it("child() namespaces combine and inherit the parent instance's config", () => {
    const cap = captureTransport();
    const base = createLogger({ minLevel: "warn", namespace: "api", transports: cap.transports });
    const child = base.child("auth");

    child.info("filtered — inherited minLevel: warn");
    expect(cap.entries).toHaveLength(0);

    child.warn("passes, namespaced api:auth");
    expect(cap.entries).toHaveLength(1);
    expect(cap.entries[0]?.context.namespace).toBe("api:auth");
  });
});

describe("sampleRate", () => {
  it("drops every entry at sampleRate 0 for that level", () => {
    const cap = captureTransport();
    const sampled = createLogger({ minLevel: "debug", sampleRate: { debug: 0 }, transports: cap.transports });
    for (let i = 0; i < 20; i++) sampled.debug(`entry ${i}`);
    expect(cap.entries).toHaveLength(0);
  });

  it("keeps every entry at sampleRate 1 for that level", () => {
    const cap = captureTransport();
    const sampled = createLogger({ minLevel: "debug", sampleRate: { debug: 1 }, transports: cap.transports });
    for (let i = 0; i < 20; i++) sampled.debug(`entry ${i}`);
    expect(cap.entries).toHaveLength(20);
  });

  it("does not affect levels not present in the sampleRate map", () => {
    const cap = captureTransport();
    const sampled = createLogger({ minLevel: "debug", sampleRate: { debug: 0 }, transports: cap.transports });
    sampled.error("errors are never sampled unless explicitly configured");
    expect(cap.entries).toHaveLength(1);
  });
});

describe("redactKeys (via transports hook, pre-redaction entry)", () => {
  it("createLogger accepts additional redactKeys without disabling the built-in defaults", () => {
    const instance = createLogger({ redactKeys: ["customSecretField"] });
    // Sanity: instance is created and callable without throwing — the actual
    // redaction behavior at write time is covered in security/__tests__.
    expect(() => instance.info("hello", { customSecretField: "x" })).not.toThrow();
  });
});
