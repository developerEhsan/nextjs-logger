/**
 * @file utils/node-fs.ts
 * Bundler-invisible access to `node:fs`.
 *
 * Two consumers need real filesystem access — `utils/source-map.ts` (reads
 * `.map` files on the synchronous write path) and `transports/file.ts`
 * (appends and rotates log files). Neither may import `node:fs` in a way
 * any bundler can see, because tsup emits one shared chunk and a consumer
 * importing *anything* from this package inside an Edge-eligible file would
 * drag a resolvable `node:fs` specifier into an Edge bundle.
 *
 * Two mechanisms, in order:
 *
 * ① `process.getBuiltinModule('node:fs')` — Node ≥ 22.3. Synchronous, and
 *    the specifier is a plain function argument, which no bundler traces.
 * ② A dynamic `import()` whose specifier is assembled at runtime with
 *    `['node','fs'].join(':')`, kicked off once and cached.
 *
 * The `join` is not stylistic. esbuild constant-folds `'node:' + 'fs'`
 * straight back into a literal, at which point the specifier is resolvable
 * again and the whole exercise is pointless. `scripts/check-edge-safety.mjs`
 * gates on `from "node:` and `import("node:` so a future "simplification"
 * fails the build rather than shipping.
 *
 * Because ② resolves asynchronously, `getFsSync()` returns `null` until it
 * settles. Callers must treat that as "not available right now" and degrade
 * — for source maps that means an unmapped frame; for the file transport it
 * means the first batch waits (it has `getFs()`, the async form, available).
 */

import { getNodeProcess } from './node-globals';

/** The subset of `node:fs` this package uses. */
export interface MinimalFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  existsSync(path: string): boolean;
  appendFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: true }): string | undefined;
  statSync(path: string): { size: number };
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  readdirSync(path: string): string[];
}

let cached: MinimalFs | null | undefined;
let pending: Promise<MinimalFs | null> | null = null;

function fromBuiltinModule(): MinimalFs | null {
  const proc = getNodeProcess() as
    | (NodeJS.Process & { getBuiltinModule?: (id: string) => unknown })
    | undefined;

  const getBuiltinModule = proc?.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') return null;

  try {
    const mod = getBuiltinModule.call(proc, 'node:fs') as MinimalFs | undefined;
    return typeof mod?.readFileSync === 'function' ? mod : null;
  } catch {
    return null;
  }
}

/** Normalise the many shapes `node:fs` can take under an ESM loader. */
function unwrap(mod: unknown): MinimalFs | null {
  const namespace = mod as Record<string, unknown> | undefined;
  if (typeof namespace?.['readFileSync'] === 'function') {
    return namespace as unknown as MinimalFs;
  }
  const asDefault = namespace?.['default'] as Record<string, unknown> | undefined;
  if (typeof asDefault?.['readFileSync'] === 'function') {
    return asDefault as unknown as MinimalFs;
  }
  return null;
}

/**
 * `node:fs` if it can be had *right now*, else `null`.
 * Starts the async import as a side effect so a later call can succeed.
 */
export function getFsSync(): MinimalFs | null {
  if (cached !== undefined) return cached;

  const builtin = fromBuiltinModule();
  if (builtin) {
    cached = builtin;
    return cached;
  }

  void getFs(); // start the background import; ignore the promise
  return null;
}

/** `node:fs`, awaiting the dynamic import if that is the only route. */
export function getFs(): Promise<MinimalFs | null> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (pending) return pending;

  const builtin = fromBuiltinModule();
  if (builtin) {
    cached = builtin;
    return Promise.resolve(cached);
  }

  // Assembled at runtime — see the file header for why this must not be a
  // literal or a foldable concatenation.
  const specifier = ['node', 'fs'].join(':');
  pending = import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier)
    .then((mod: unknown) => {
      cached = unwrap(mod);
      return cached;
    })
    .catch(() => {
      // No filesystem (Edge Runtime, browser, a locked-down sandbox).
      cached = null;
      return cached;
    });

  return pending;
}

/** Reset the cache. Exported for tests only. */
export function _resetFsCache(): void {
  cached = undefined;
  pending = null;
}
