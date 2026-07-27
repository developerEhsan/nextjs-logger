/**
 * @file core/level-filter.ts
 * Per-namespace log level control, configurable at runtime through an
 * environment variable.
 *
 *   LOG_LEVEL=debug:checkout,warn:db:*,info:*
 *
 * ── Why this shape ───────────────────────────────────────────────────────
 * The `debug` package's `DEBUG=app:*,-app:noisy` syntax is the one people
 * already have in their fingers, so the pattern language matches it: `*`
 * wildcards, comma separation, `-` to silence. What it does *not* copy is
 * `debug`'s on/off-only model — a logger has levels, so each rule carries
 * one, and the whole point is being able to say "debug for the checkout
 * flow, warnings only for the database chatter, info for everything else"
 * without a redeploy.
 *
 * ── Precedence: last match wins ──────────────────────────────────────────
 * Rules are evaluated in order and the **last** one whose pattern matches
 * the namespace wins. "Most specific wins" is the obvious alternative and
 * it is a trap: specificity has no total order (`a:*:c` vs `a:b:*`), so it
 * would need tie-breaking rules nobody can predict from reading their own
 * config. Last-match-wins is what `debug` does, it reads left-to-right as
 * "general default, then exceptions", and it is trivially explainable:
 *
 *   LOG_LEVEL=info:*,debug:checkout,-checkout:polling
 *   → info everywhere, debug under `checkout`, nothing from
 *     `checkout:polling`.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────
 * Resolution sits on the synchronous path of every log call, before the
 * level gate, so it is memoised per namespace. The cache is keyed on the
 * rule set's identity, so `configureLogger()` swapping the rules
 * invalidates it without any explicit bookkeeping.
 */

import { LOG_LEVEL, type LogLevel } from './types';

/** One parsed `level:pattern` rule. */
export interface LevelRule {
  /** `null` means "silence entirely" — the `-pattern` form. */
  level: LogLevel | null;
  /** The namespace glob, e.g. `checkout`, `db:*`, `*`. */
  pattern: string;
  /** Compiled form of `pattern`. */
  test: (namespace: string) => boolean;
}

const VALID_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error', 'fatal']);

/**
 * Compile a namespace glob.
 *
 * `*` matches any run of characters including `:`, which is the behaviour
 * people expect from `db:*` (it should match `db:pool:acquire`, not just
 * `db:pool`). An exact pattern also matches its children — `checkout`
 * matches `checkout:payment` — because a namespace hierarchy where
 * configuring the parent does not configure the children would be useless.
 */
function compilePattern(pattern: string): (namespace: string) => boolean {
  if (pattern === '*') return () => true;

  if (pattern.includes('*')) {
    const source =
      '^' +
      pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$';
    const re = new RegExp(source);
    return (namespace) => re.test(namespace);
  }

  return (namespace) => namespace === pattern || namespace.startsWith(`${pattern}:`);
}

/**
 * Parse a `LOG_LEVEL`-style specification. Unparseable rules are skipped
 * rather than throwing — a typo in an env var must not take down the app,
 * and a logger is the last thing that should refuse to start.
 *
 * Accepted rule forms:
 *   `debug:checkout`  – level for a namespace
 *   `debug`           – level for everything (shorthand for `debug:*`)
 *   `-checkout:poll`  – silence a namespace entirely
 */
export function parseLevelSpec(spec: string): LevelRule[] {
  const rules: LevelRule[] = [];

  for (const raw of spec.split(',')) {
    const token = raw.trim();
    if (!token) continue;

    if (token.startsWith('-')) {
      const pattern = token.slice(1).trim();
      if (pattern) rules.push({ level: null, pattern, test: compilePattern(pattern) });
      continue;
    }

    const separator = token.indexOf(':');

    // A bare level applies everywhere.
    if (separator === -1) {
      if (VALID_LEVELS.has(token)) {
        rules.push({ level: token as LogLevel, pattern: '*', test: () => true });
      }
      continue;
    }

    const level = token.slice(0, separator).trim();
    const pattern = token.slice(separator + 1).trim();
    if (!VALID_LEVELS.has(level) || !pattern) continue;

    rules.push({
      level: level as LogLevel,
      pattern,
      test: compilePattern(pattern),
    });
  }

  return rules;
}

/** Read the `LOG_LEVEL` env var, if set and non-empty. */
export function levelRulesFromEnv(): LevelRule[] | undefined {
  const spec = typeof process !== 'undefined' ? process.env?.LOG_LEVEL : undefined;
  if (!spec) return undefined;
  const rules = parseLevelSpec(spec);
  return rules.length > 0 ? rules : undefined;
}

// ─── Resolution ──────────────────────────────────────────────────────────

/**
 * Memoised namespace → effective level. Keyed by rule set so that swapping
 * rules (via `configureLogger`) invalidates without explicit bookkeeping;
 * the inner map is bounded because a namespace is usually a literal in
 * source, but `log.child(userId)` would otherwise make it unbounded.
 */
const resolutionCache = new WeakMap<LevelRule[], Map<string, LogLevel | null>>();

const MAX_CACHED_NAMESPACES = 512;

/**
 * The effective minimum level for `namespace`, or `null` if it is silenced.
 * Returns `fallback` when no rule matches.
 */
export function resolveLevel(
  namespace: string | undefined,
  rules: LevelRule[] | undefined,
  fallback: LogLevel,
): LogLevel | null {
  if (!rules || rules.length === 0) return fallback;

  const key = namespace ?? '';

  let cache = resolutionCache.get(rules);
  if (!cache) {
    cache = new Map();
    resolutionCache.set(rules, cache);
  }

  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // Last match wins — see the header.
  let resolved: LogLevel | null = fallback;
  for (const rule of rules) {
    if (rule.test(key)) resolved = rule.level;
  }

  if (cache.size >= MAX_CACHED_NAMESPACES) cache.clear();
  cache.set(key, resolved);

  return resolved;
}

/**
 * Would an entry at `level` in `namespace` be written?
 * Exported so tooling (and tests) can ask without emitting anything.
 */
export function isLevelEnabled(
  level: LogLevel,
  namespace: string | undefined,
  rules: LevelRule[] | undefined,
  fallback: LogLevel,
): boolean {
  const minimum = resolveLevel(namespace, rules, fallback);
  if (minimum === null) return false;
  return LOG_LEVEL[level] >= LOG_LEVEL[minimum];
}
