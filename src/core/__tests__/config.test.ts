/**
 * @file core/__tests__/config.test.ts
 * Regression test for a bug where `buildDefaultConfig()` derived the relay
 * secret *eagerly*: `deriveRelaySecret()` ran as soon as the config object
 * was constructed, which happens at module-import time for the `log`
 * singleton and on every `createLogger()` call. In production, with no
 * `LOGGER_RELAY_SECRET`/`NEXTAUTH_SECRET`/`APP_SECRET` set,
 * `deriveRelaySecret()` throws — so merely `import`-ing the package (or
 * calling `createLogger()`), with no relay ever wired up, crashed the app.
 *
 * The fix makes `relaySecret` a lazy getter: it's only computed (and can
 * only throw) the first time something actually reads `config.relaySecret`
 * — i.e. the relay code paths that need it, not every logger instance.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildDefaultConfig } from '../config';

describe('buildDefaultConfig — lazy relaySecret derivation', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  it('does not throw at construction time even with no secret configured in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOGGER_RELAY_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.APP_SECRET;

    // This must not throw — deriveRelaySecret() should not run yet.
    expect(() => buildDefaultConfig()).not.toThrow();
  });

  it('only throws once relaySecret is actually read, and only that read fails', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOGGER_RELAY_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.APP_SECRET;

    const cfg = buildDefaultConfig();
    expect(() => cfg.relaySecret).toThrow(/LOGGER_RELAY_SECRET must be set/);
  });

  it('returns the derived secret when one is configured, and caches it', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOGGER_RELAY_SECRET = 'a'.repeat(32);

    const cfg = buildDefaultConfig();
    const first = cfg.relaySecret;
    const second = cfg.relaySecret;
    expect(first).toBe('a'.repeat(32));
    expect(second).toBe(first);
  });

  it('respects an explicit relaySecret override without deferring or re-deriving it', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOGGER_RELAY_SECRET;

    const cfg = buildDefaultConfig({ relaySecret: 'explicit-override-secret' });
    expect(cfg.relaySecret).toBe('explicit-override-secret');
  });

  it('never throws on the client, regardless of env', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    process.env.NODE_ENV = 'production';
    delete process.env.LOGGER_RELAY_SECRET;

    try {
      const cfg = buildDefaultConfig();
      expect(cfg.relaySecret).toBe('__client__');
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });
});
