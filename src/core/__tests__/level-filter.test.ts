/**
 * @file core/__tests__/level-filter.test.ts
 *
 * The rule that needs pinning hardest is precedence: last match wins. It is
 * the difference between `LOG_LEVEL=info:*,debug:checkout` doing what it
 * obviously reads as and doing the opposite.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseLevelSpec, resolveLevel, isLevelEnabled } from '../level-filter';
import { createLogger } from '../logger';

const rules = (spec: string) => parseLevelSpec(spec);

describe('parseLevelSpec', () => {
  it('parses level:pattern pairs', () => {
    const parsed = rules('debug:checkout,warn:db');
    expect(parsed.map((rule) => [rule.level, rule.pattern])).toEqual([
      ['debug', 'checkout'],
      ['warn', 'db'],
    ]);
  });

  it('treats a bare level as applying everywhere', () => {
    expect(rules('warn')).toEqual([
      expect.objectContaining({ level: 'warn', pattern: '*' }),
    ]);
  });

  it('parses the silencing form', () => {
    expect(rules('-checkout:polling')[0]).toMatchObject({
      level: null,
      pattern: 'checkout:polling',
    });
  });

  it('skips garbage rather than throwing', () => {
    // A typo in an env var must never stop the app from starting.
    expect(() => rules('nonsense:x,,:,warn:ok,verbose')).not.toThrow();
    expect(rules('nonsense:x,,:,warn:ok,verbose')).toHaveLength(1);
  });

  it('tolerates whitespace', () => {
    expect(rules(' debug : checkout , warn : db ')).toHaveLength(2);
  });
});

describe('resolveLevel', () => {
  it('applies the last matching rule, not the most specific one', () => {
    const parsed = rules('info:*,debug:checkout');
    expect(resolveLevel('checkout', parsed, 'error')).toBe('debug');
    expect(resolveLevel('billing', parsed, 'error')).toBe('info');
  });

  it('lets a later general rule override an earlier specific one', () => {
    // The flip side of last-match-wins, and the reason it is documented:
    // order is the only thing that matters.
    const parsed = rules('debug:checkout,error:*');
    expect(resolveLevel('checkout', parsed, 'info')).toBe('error');
  });

  it('matches child namespaces of an exact pattern', () => {
    // Configuring a parent must configure its children, or a namespace
    // hierarchy is pointless.
    const parsed = rules('debug:checkout');
    expect(resolveLevel('checkout:payment', parsed, 'error')).toBe('debug');
    // …but not a namespace that merely starts with the same characters.
    expect(resolveLevel('checkoutOther', parsed, 'error')).toBe('error');
  });

  it('supports wildcards that span segment separators', () => {
    const parsed = rules('debug:db:*');
    expect(resolveLevel('db:pool:acquire', parsed, 'error')).toBe('debug');
  });

  it('returns null for a silenced namespace', () => {
    const parsed = rules('debug:*,-noisy');
    expect(resolveLevel('noisy', parsed, 'info')).toBeNull();
    expect(resolveLevel('quiet', parsed, 'info')).toBe('debug');
  });

  it('falls back when nothing matches', () => {
    expect(resolveLevel('other', rules('debug:checkout'), 'warn')).toBe('warn');
  });

  it('falls back with no rules at all', () => {
    expect(resolveLevel('any', undefined, 'info')).toBe('info');
    expect(resolveLevel('any', [], 'info')).toBe('info');
  });
});

describe('isLevelEnabled', () => {
  it('gates on the resolved level', () => {
    // General default first, then the exception — the order last-match-wins
    // is designed to read in. Reversing these two would (correctly) put
    // `db` back on `debug`.
    const parsed = rules('debug:*,warn:db');
    expect(isLevelEnabled('info', 'db', parsed, 'debug')).toBe(false);
    expect(isLevelEnabled('error', 'db', parsed, 'debug')).toBe(true);
  });

  it('is false for everything in a silenced namespace, including fatal', () => {
    const parsed = rules('-dead');
    expect(isLevelEnabled('fatal', 'dead', parsed, 'debug')).toBe(false);
  });
});

describe('integration with the logger', () => {
  function capture(fn: () => void): string[] {
    const lines: string[] = [];
    const record = (chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    };
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(record);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(record);
    try {
      fn();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    return lines.join('').split('\n').filter(Boolean);
  }

  it('turns one namespace up without turning everything up', () => {
    const levelRules = rules('info:*,debug:checkout');
    const checkout = createLogger({ namespace: 'checkout', minLevel: 'debug', levelRules });
    const billing = createLogger({ namespace: 'billing', minLevel: 'debug', levelRules });

    const lines = capture(() => {
      checkout.debug('visible');
      billing.debug('filtered out');
      billing.info('visible too');
    });

    expect(lines).toHaveLength(2);
    expect(lines.join('')).toContain('visible');
    expect(lines.join('')).not.toContain('filtered out');
  });

  it('silences a namespace entirely', () => {
    const levelRules = rules('debug:*,-spam');
    const spam = createLogger({ namespace: 'spam', minLevel: 'debug', levelRules });

    expect(capture(() => spam.fatal('should not appear'))).toHaveLength(0);
  });

  it('applies to child loggers by their combined namespace', () => {
    const levelRules = rules('error:*,debug:api:auth');
    const api = createLogger({ namespace: 'api', minLevel: 'debug', levelRules });

    const lines = capture(() => {
      api.child('auth').debug('auth debug is on');
      api.child('cache').debug('cache debug is off');
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('auth debug is on');
  });
});
