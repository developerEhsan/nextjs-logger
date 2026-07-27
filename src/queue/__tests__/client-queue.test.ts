/**
 * @file queue/__tests__/client-queue.test.ts
 * Covers the ring buffer eviction behavior and basic flush wiring — this
 * module previously had zero test coverage despite being the only thing
 * standing between a chatty client component and the relay endpoint.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../transport/client", () => ({
  relayEntries: vi.fn().mockResolvedValue(undefined),
  relayEntriesBeacon: vi.fn(),
}));

import { ClientQueue, _resetClientQueue } from "../client-queue";
import { relayEntries } from "../../transport/client";
import type { LogEntry } from "../../core/types";

function makeEntry(sequence: number): LogEntry {
  return {
    level: "debug",
    message: `entry-${sequence}`,
    context: {
      runtime: "client",
      timestamp: new Date().toISOString(),
      sequence,
    },
  };
}

describe("ClientQueue ring buffer", () => {
  beforeEach(() => {
    _resetClientQueue();
    vi.clearAllMocks();
  });

  it("evicts the oldest entry once the buffer exceeds maxQueueSize", async () => {
    const queue = new ClientQueue({
      maxQueueSize: 3,
      pacerPolicies: {
        debug: { strategy: "debounce", waitMs: 60_000 },
      },
      transportOptions: { relayUrl: "/api/log-relay", signedToken: "t", issuedAt: new Date().toISOString() },
    });

    for (let i = 0; i < 5; i++) queue.enqueue(makeEntry(i));
    await queue.flush();

    expect(relayEntries).toHaveBeenCalledTimes(1);
    const shipped = (relayEntries as any).mock.calls[0][0] as LogEntry[];
    // Oldest two (0, 1) were evicted; only the last 3 survive.
    expect(shipped.map((e) => e.message)).toEqual(["entry-2", "entry-3", "entry-4"]);
  });

  it("flush() is a no-op when the buffer is empty", async () => {
    const queue = new ClientQueue({
      maxQueueSize: 10,
      pacerPolicies: { debug: { strategy: "debounce", waitMs: 60_000 } },
      transportOptions: { relayUrl: "/api/log-relay", signedToken: "t", issuedAt: new Date().toISOString() },
    });

    await queue.flush();
    expect(relayEntries).not.toHaveBeenCalled();
  });

  it("re-enqueues entries (up to 3 retries) when relayEntries throws", async () => {
    (relayEntries as any).mockRejectedValueOnce(new Error("network down"));

    const queue = new ClientQueue({
      maxQueueSize: 10,
      pacerPolicies: { debug: { strategy: "debounce", waitMs: 60_000 } },
      transportOptions: { relayUrl: "/api/log-relay", signedToken: "t", issuedAt: new Date().toISOString() },
    });

    queue.enqueue(makeEntry(0));
    await queue.flush(); // fails, re-enqueues with retries: 1

    (relayEntries as any).mockResolvedValueOnce(undefined);
    await queue.flush(); // succeeds this time

    expect(relayEntries).toHaveBeenCalledTimes(2);
    const secondAttemptEntries = (relayEntries as any).mock.calls[1][0] as LogEntry[];
    expect(secondAttemptEntries).toHaveLength(1);

    // Cancels the 2 s retry timer the failed flush scheduled, so it can't fire
    // into a later test.
    queue.destroy();
  });

  it("destroy() discards buffered entries and ignores further enqueues", async () => {
    const queue = new ClientQueue({
      maxQueueSize: 10,
      pacerPolicies: { debug: { strategy: "debounce", waitMs: 60_000 } },
      transportOptions: { relayUrl: "/api/log-relay", signedToken: "t", issuedAt: new Date().toISOString() },
    });

    queue.enqueue(makeEntry(0));
    queue.destroy();
    queue.enqueue(makeEntry(1));
    await queue.flush();

    expect(relayEntries).not.toHaveBeenCalled();
  });
});

describe("ClientQueue never relays on the caller's stack", () => {
  beforeEach(() => {
    _resetClientQueue();
    vi.clearAllMocks();
  });

  /**
   * The regression this pins: `enqueue()` used to invoke the level's Pacer
   * inline, and a `throttle` policy fires its leading edge synchronously. So
   * a `log.info()` in a component's render body reached `relayEntries` — and
   * therefore the relay Server Action, and therefore Next's router — while
   * React was still rendering that component:
   *
   *   Cannot update a component (`Router`) while rendering a different
   *   component (`LoggerPlayground`).
   *
   * A log call must return having done nothing but append to the buffer.
   */
  it("does not call relayEntries synchronously from enqueue(), even on a leading-edge throttle", () => {
    const queue = new ClientQueue({
      maxQueueSize: 10,
      // `leading: true` throttle — the exact policy that fired inline before.
      pacerPolicies: { debug: { strategy: "throttle", windowMs: 500 } },
      transportOptions: { relayUrl: "/api/log-relay", signedToken: "t", issuedAt: new Date().toISOString() },
    });

    queue.enqueue(makeEntry(0));

    expect(relayEntries).not.toHaveBeenCalled();
    queue.destroy();
  });

  it("still relays once the stack unwinds", async () => {
    const queue = new ClientQueue({
      maxQueueSize: 10,
      pacerPolicies: { debug: { strategy: "throttle", windowMs: 500 } },
      transportOptions: { relayUrl: "/api/log-relay", signedToken: "t", issuedAt: new Date().toISOString() },
    });

    queue.enqueue(makeEntry(0));
    await new Promise((r) => setTimeout(r, 20));

    expect(relayEntries).toHaveBeenCalledTimes(1);
    queue.destroy();
  });

  it("collapses a synchronous burst into a single relay call", async () => {
    const queue = new ClientQueue({
      maxQueueSize: 100,
      pacerPolicies: { debug: { strategy: "throttle", windowMs: 500 } },
      transportOptions: { relayUrl: "/api/log-relay", signedToken: "t", issuedAt: new Date().toISOString() },
    });

    // A loop, or a component re-rendering hard. Twenty triggers would burn a
    // rateLimit budget in one tick; one deferred trigger is enough.
    for (let i = 0; i < 20; i++) queue.enqueue(makeEntry(i));
    await new Promise((r) => setTimeout(r, 20));

    expect(relayEntries).toHaveBeenCalledTimes(1);
    const shipped = (relayEntries as any).mock.calls[0][0] as LogEntry[];
    expect(shipped).toHaveLength(20);
    queue.destroy();
  });
});
