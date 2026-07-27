/**
 * @file utils/caller.ts
 * Extracts a human-readable "file:line" string from the call stack.
 *
 * This only runs on the server (Node.js) because:
 *  • Client-side stack traces are minified/obfuscated in production builds,
 *    making them useless and a potential source-map information leak.
 *  • We never want client stack details reaching the terminal anyway.
 *
 * ── Why the frame filter is derived, not hardcoded ───────────────────────
 * The previous implementation matched a fixed list of path fragments
 * (`/logger/`, `/core/logger`, …) to decide which frames were "ours". It
 * never matched this file, so the very first frame it examined — its own —
 * always won, and every server log line reported:
 *
 *   caller: "src/utils/caller.ts:37"
 *
 * That is the location of the `new Error()` below, i.e. a constant. The
 * feature was inert while still paying for a stack capture on every call.
 * The fragments were also wrong for consumers: once the package is installed
 * and bundled, library code lives in `node_modules/…/dist/chunk-*.js` and
 * matches none of them.
 *
 * So the filter is derived from `import.meta.url` instead, which is correct
 * in all three layouts: this repo's `src/`, an unbundled `dist/`, and a
 * single bundled chunk (where every library frame shares this file path).
 *
 * ── Why it is opt-in ─────────────────────────────────────────────────────
 * Capturing and materialising a stack is one of the more expensive things
 * V8 does, and this sits on the synchronous path of every server-side log.
 * It defaults to development only. See `LoggerConfig.captureCaller`.
 *
 * ── Known limitation ─────────────────────────────────────────────────────
 * When a bundler inlines the library into the *application's* chunk — which
 * Turbopack does for a local file: dependency — caller and app frames share
 * one file, so the reported location degrades to that chunk path. This is
 * best-effort context, never something to depend on programmatically.
 */

import { getNodeCwd } from "./node-globals";
import { parseLocation, resolveOriginalPosition } from "./source-map";

/** Subdirectories that make up this library's own source tree. */
const LIB_SUBDIRS = [
  "core",
  "queue",
  "transport",
  "utils",
  "provider",
  "relay",
  "security",
];

/**
 * Absolute path of this module, derived without `node:url` so the module
 * stays importable on runtimes that lack Node built-ins (the Edge-safety
 * gate in `scripts/check-edge-safety.mjs` rejects them here).
 */
const SELF_PATH: string = (() => {
  try {
    const url = import.meta.url;
    if (!url?.startsWith("file://")) return "";
    return decodeURIComponent(url.slice("file://".length));
  } catch {
    return "";
  }
})();

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

/**
 * Path fragments that identify a frame as belonging to this library.
 *
 * `SELF_PATH` alone covers the bundled case (all library code in one file).
 * The per-subdirectory entries cover the unbundled layouts, anchored to both
 * this file's directory and its parent so `src/utils/caller.ts` yields
 * `…/src/core/` and `dist/chunk.js` yields `…/dist/core/`.
 */
const LIB_FRAME_MARKERS: string[] = (() => {
  if (!SELF_PATH) return [];
  const selfDir = dirname(SELF_PATH);
  const parentDir = dirname(selfDir);
  const markers = [SELF_PATH];
  for (const base of [selfDir, parentDir]) {
    if (!base) continue;
    for (const sub of LIB_SUBDIRS) markers.push(`${base}/${sub}/`);
  }
  return markers;
})();

/**
 * Walk the stack trace and return the first frame that does not belong
 * to this library's own source files.
 */
export interface CallerOptions {
  /**
   * Resolve the frame through the build's source maps before returning it.
   *
   * This is what turns the "known limitation" documented above — a
   * Turbopack-inlined chunk path like `.next/dev/server/chunks/ssr/…js:563`
   * — into `app/checkout/page.tsx:18`. It is opt-in per call because the
   * decision belongs to config (`LoggerConfig.sourceMaps`), and because the
   * first lookup for a chunk reads its map off disk.
   */
  sourceMaps?: boolean;
}

export function getCallerLocation(options: CallerOptions = {}): string | undefined {
  // Only meaningful server-side; also avoids leaking absolute filesystem
  // paths into terminal output from browser-originated entries.
  if (typeof window !== "undefined") return undefined;

  // Only as many frames as we might plausibly need to skip past the library.
  // The default (10) costs more to format than we use.
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 20;
  const stack = new Error().stack;
  Error.stackTraceLimit = previousLimit;

  if (!stack) return undefined;

  const lines = stack.split("\n").slice(1); // drop "Error" header line

  for (const line of lines) {
    if (LIB_FRAME_MARKERS.some((marker) => line.includes(marker))) {
      continue;
    }

    // Typical V8 frame: "    at functionName (/abs/path/file.ts:12:34)"
    const match = line.match(/\(([^)]+)\)\s*$/) ?? line.match(/at\s+(.+)$/);
    if (!match) continue;

    let raw = match[1]?.trim();
    if (!raw) continue;

    // Ignore Node internals ("node:internal/…") and frames with no location.
    if (raw.startsWith("node:")) continue;

    // Source-map resolution happens *before* the scheme strip and the
    // cwd-shortening below, because it needs the location exactly as the
    // frame reported it (`toDiskPath` handles `file://` itself, and a
    // browser-style URL would be destroyed by the cwd logic). On success it
    // already returns a clean, cwd-relative original path, so return
    // straight out rather than putting it back through shortening built for
    // generated paths.
    if (options.sourceMaps) {
      const position = parseLocation(raw);
      const original = position ? resolveOriginalPosition(position) : null;
      if (original) return `${original.file}:${original.line}`;
    }

    // V8 reports ESM frames as `file:///abs/path`. Strip the scheme so the
    // cwd-relative shortening below can actually match — otherwise every
    // frame under an ESM loader (Vitest, and Next's server runtime) printed
    // as a full absolute URL.
    if (raw.startsWith("file://")) {
      raw = decodeURIComponent(raw.slice("file://".length));
    }

    // Reduce to "relative/path/file.ts:line" for compact terminal output
    const cwdPath = getNodeCwd() ?? "";
    const cleaned =
      cwdPath && raw.startsWith(cwdPath) ? raw.slice(cwdPath.length + 1) : raw;

    // Strip column number — line number is usually sufficient for humans
    return cleaned.replace(/:(\d+):\d+$/, ":$1");
  }

  return undefined;
}
