/**
 * @file utils/caller.ts
 * Extracts a human-readable "file:line" string from the call stack.
 *
 * This only runs on the server (Node.js) because:
 *  • Client-side stack traces are minified/obfuscated in production builds,
 *    making them useless and a potential source-map information leak.
 *  • We never want client stack details reaching the terminal anyway.
 *
 * Implementation notes:
 *  • We use `Error().stack` rather than `Error.captureStackTrace` with a
 *    custom prepareStackTrace because the latter is V8-specific and can
 *    interfere with other libraries (e.g. source-map-support) that also
 *    patch `Error.prepareStackTrace`.
 *  • We skip frames belonging to this library itself so the reported
 *    location is always the *caller's* file, not logger internals.
 */

import { cwd } from "process";

const LIB_FRAME_MARKERS = [
  "/logger/",
  "/core/logger",
  "/queue/client-queue",
  "/transport/",
];

/**
 * Walk the stack trace and return the first frame that does not belong
 * to this library's own source files.
 */
export function getCallerLocation(): string | undefined {
  // Only meaningful server-side; also skip in production to avoid
  // leaking absolute filesystem paths into terminal output by default.
  if (typeof window !== "undefined") return undefined;

  const err = new Error();
  const stack = err.stack;
  if (!stack) return undefined;

  const lines = stack.split("\n").slice(1); // drop "Error" header line

  for (const line of lines) {
    if (LIB_FRAME_MARKERS.some((marker) => line.includes(marker))) {
      continue;
    }

    // Typical V8 frame: "    at functionName (/abs/path/file.ts:12:34)"
    const match = line.match(/\(([^)]+)\)\s*$/) ?? line.match(/at\s+(.+)$/);
    if (!match) continue;

    const raw = match[1]?.trim();
    if (!raw) continue;
    // Reduce to "relative/path/file.ts:line" for compact terminal output
    const cwdPath =
      typeof process !== "undefined" && typeof process.cwd === "function" ?
        process.cwd()
      : "";
    const cleaned =
      raw?.startsWith(cwdPath) ? raw.slice(cwdPath.length + 1) : raw;

    // Strip column number — line number is usually sufficient for humans
    return cleaned?.replace(/:(\d+):\d+$/, ":$1");
  }

  return undefined;
}
