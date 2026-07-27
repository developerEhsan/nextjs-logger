/**
 * @file utils/source-map.ts
 * Server-side resolution of a bundled `file:line:col` back to the original
 * source file, so log output names files a human wrote.
 *
 * ── The problem it solves, twice ─────────────────────────────────────────
 * ① Client stack traces. A browser error relayed to the terminal reports
 *    frames inside `/_next/static/chunks/app/page.js:2:48219`. Printing
 *    that is barely better than printing nothing.
 * ② The `caller` field. `utils/caller.ts` already documents that when a
 *    bundler inlines this library into the application's chunk — which
 *    Turbopack does — the caller location degrades to
 *    `.next/dev/server/chunks/ssr/…js:563`. It correctly distinguishes call
 *    sites but names none of them.
 * Both are the same operation: take a generated position, find the map,
 * return the original position.
 *
 * ── Why the mappings are decoded here rather than with a library ─────────
 * `source-map`/`@jridgewell/trace-mapping` would do this, but this package
 * ships with exactly one runtime dependency and adding a WASM-backed one
 * for a best-effort dev-time nicety is a bad trade. The Source Map v3
 * mappings field is base64-VLQ, which is ~40 lines to decode, and we only
 * ever need the `generated line/col → source, line, col` direction.
 *
 * ── Why file reads are synchronous ───────────────────────────────────────
 * The terminal write path is synchronous by design (see
 * `transport/server.ts`), so mapping has to be too. Filesystem access goes
 * through `utils/node-fs.ts`, which reaches `node:fs` in a way no bundler
 * can see — read that file's header before touching it. Until it is
 * available, `getFsSync()` returns null and mapping is simply skipped, so
 * the first log or two of a process may print unmapped frames.
 * No path here can throw into the caller; a failure to map is always a
 * silent fallback to the generated location.
 *
 * ── Everything here is best-effort ───────────────────────────────────────
 * A missing map, a `.map` that was never emitted, a Turbopack layout that
 * changes next release — all of these produce the original unmapped string.
 * Nothing in the library depends on mapping succeeding.
 */

import { getNodeCwd } from './node-globals';
import { getFsSync } from './node-fs';

// ─── Base64 VLQ decoding ─────────────────────────────────────────────────

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_INDEX: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < B64.length; i++) table[B64[i]!] = i;
  return table;
})();

/**
 * Decode one comma-free VLQ group (a "segment") into its integer fields.
 * Source Map v3 segments have 1, 4 or 5 fields; we use fields 0 (generated
 * column), 1 (source index), 2 (original line) and 3 (original column).
 */
function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;

  for (let i = 0; i < segment.length; i++) {
    const digit = B64_INDEX[segment[i]!];
    if (digit === undefined) return values; // malformed — take what we have

    const hasContinuation = (digit & 32) !== 0;
    value += (digit & 31) << shift;

    if (hasContinuation) {
      shift += 5;
    } else {
      const negative = (value & 1) === 1;
      value >>= 1;
      values.push(negative ? -value : value);
      value = 0;
      shift = 0;
    }
  }

  return values;
}

// ─── Parsed map representation ───────────────────────────────────────────

interface Segment {
  /** 0-based column in the generated file. */
  generatedColumn: number;
  /** Index into `sources`. */
  sourceIndex: number;
  /** 0-based line in the original source. */
  originalLine: number;
  /** 0-based column in the original source. */
  originalColumn: number;
}

interface ParsedMap {
  sources: string[];
  /** Segments per generated line (0-based index), sorted by column. */
  lines: Segment[][];
}

interface RawSourceMap {
  version?: number;
  sources?: unknown;
  sourceRoot?: unknown;
  mappings?: unknown;
  sections?: unknown;
}

function parseSourceMap(json: string): ParsedMap | null {
  let raw: RawSourceMap;
  try {
    raw = JSON.parse(json) as RawSourceMap;
  } catch {
    return null;
  }

  // Indexed maps (`sections`) are used by some bundlers for very large
  // outputs. Supporting them properly means offsetting every section's
  // mappings; not worth it for a best-effort feature, so bail cleanly.
  if (Array.isArray(raw.sections)) return null;

  if (typeof raw.mappings !== 'string' || !Array.isArray(raw.sources)) return null;

  const sourceRoot = typeof raw.sourceRoot === 'string' ? raw.sourceRoot : '';
  const sources = raw.sources.map((s) =>
    typeof s === 'string' ? (sourceRoot ? joinSourceRoot(sourceRoot, s) : s) : '',
  );

  const lines: Segment[][] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;

  for (const lineMappings of raw.mappings.split(';')) {
    const segments: Segment[] = [];
    // Generated column resets per line; the other three fields do not —
    // they are deltas carried across the whole mappings string.
    let generatedColumn = 0;

    if (lineMappings.length > 0) {
      for (const segment of lineMappings.split(',')) {
        if (!segment) continue;
        const fields = decodeVlqSegment(segment);
        if (fields.length === 0) continue;

        generatedColumn += fields[0]!;

        // A 1-field segment marks generated code with no original position.
        if (fields.length >= 4) {
          sourceIndex += fields[1]!;
          originalLine += fields[2]!;
          originalColumn += fields[3]!;
          segments.push({ generatedColumn, sourceIndex, originalLine, originalColumn });
        }
      }
    }

    lines.push(segments);
  }

  return { sources, lines };
}

function joinSourceRoot(root: string, source: string): string {
  if (!root) return source;
  return root.endsWith('/') ? root + source : `${root}/${source}`;
}

/**
 * Find the segment covering `column` on `line`: the last segment whose
 * generated column is ≤ the one we are looking for. Binary search, because
 * a single minified line routinely holds thousands of segments.
 */
function findSegment(segments: Segment[], column: number): Segment | undefined {
  if (segments.length === 0) return undefined;

  let low = 0;
  let high = segments.length - 1;
  let found: Segment | undefined;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid]!;
    if (segment.generatedColumn <= column) {
      found = segment;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Column past every segment, or before the first: the first segment on
  // the line is still a better answer than nothing.
  return found ?? segments[0];
}

// ─── Map lookup + cache ──────────────────────────────────────────────────

/**
 * Parsed maps, keyed by generated file path. `null` records a negative
 * result (no map, unreadable, unparseable) so a missing map is not
 * re-attempted on every log line — the failure case must be as cheap as
 * the success case, since in production most files have no map at all.
 */
const mapCache = new Map<string, ParsedMap | null>();

/** Bound on `mapCache`, so a long-lived process cannot grow it without limit. */
const MAX_CACHED_MAPS = 64;

const SOURCE_MAPPING_URL_RE = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/;

const INLINE_MAP_PREFIX = 'data:application/json';

function loadMap(generatedFile: string): ParsedMap | null {
  const cached = mapCache.get(generatedFile);
  if (cached !== undefined) return cached;

  const parsed = readAndParseMap(generatedFile);

  if (mapCache.size >= MAX_CACHED_MAPS) {
    // Wholesale clear rather than LRU eviction: the working set of chunk
    // files is small and stable, so this effectively never fires, and a
    // simple bound is worth more here than an accurate one.
    mapCache.clear();
  }
  mapCache.set(generatedFile, parsed);
  return parsed;
}

function readAndParseMap(generatedFile: string): ParsedMap | null {
  const fs = getFsSync();
  if (!fs) return null;

  try {
    // The conventional sibling `.map` first — one stat, no read of a
    // potentially multi-megabyte bundle.
    const sibling = `${generatedFile}.map`;
    if (fs.existsSync(sibling)) {
      return parseSourceMap(fs.readFileSync(sibling, 'utf8'));
    }

    if (!fs.existsSync(generatedFile)) return null;

    const source = fs.readFileSync(generatedFile, 'utf8');
    const comment = findSourceMappingUrl(source);
    if (!comment) return null;

    if (comment.startsWith(INLINE_MAP_PREFIX)) {
      const base64Marker = ';base64,';
      const index = comment.indexOf(base64Marker);
      if (index === -1) {
        const commaIndex = comment.indexOf(',');
        return commaIndex === -1
          ? null
          : parseSourceMap(decodeURIComponent(comment.slice(commaIndex + 1)));
      }
      return parseSourceMap(decodeBase64(comment.slice(index + base64Marker.length)));
    }

    const resolved = resolveRelative(generatedFile, comment);
    if (!fs.existsSync(resolved)) return null;
    return parseSourceMap(fs.readFileSync(resolved, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Scan only the tail of the file for the `sourceMappingURL` comment. It is
 * always last, and bundles are large enough that splitting the whole thing
 * into lines is a genuinely wasteful way to read the final one.
 */
function findSourceMappingUrl(source: string): string | null {
  const tail = source.slice(Math.max(0, source.length - 2048));
  for (const line of tail.split('\n').reverse()) {
    const match = SOURCE_MAPPING_URL_RE.exec(line.trim());
    if (match) return match[1]!;
  }
  return null;
}

function decodeBase64(input: string): string {
  // `atob` is available on every runtime this package targets, and unlike
  // `Buffer.from` it does not trip the Edge-safety scanner.
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function resolveRelative(fromFile: string, relative: string): string {
  if (relative.startsWith('/')) return relative;
  const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  const parts = `${dir}/${relative}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

// ─── Generated location → disk path ──────────────────────────────────────

/**
 * Turn the location a stack frame reports into a path on this server's
 * disk, or `null` when it cannot be one.
 *
 * Three shapes arrive here:
 *   • `file:///abs/path/chunk.js`      — any ESM server frame
 *   • `/abs/path/chunk.js`             — CJS server frames
 *   • `https://host/_next/static/…js`  — every frame in a relayed browser
 *                                        stack, which is the whole reason
 *                                        this function is not just a
 *                                        `file://` strip
 */
function toDiskPath(location: string): string | null {
  if (location.startsWith('file://')) {
    try {
      return decodeURIComponent(location.slice('file://'.length));
    } catch {
      return location.slice('file://'.length);
    }
  }

  if (location.startsWith('http://') || location.startsWith('https://')) {
    let pathname: string;
    try {
      pathname = new URL(location).pathname;
    } catch {
      return null;
    }

    // Browser asset URLs map onto the build output directory. Only
    // `/_next/`-served assets are mapped: an arbitrary path could be
    // anything, and turning attacker-influenced URL text into a filesystem
    // read is not something to do loosely. `..` cannot survive `new URL`
    // normalisation, and the prefix check pins the read inside `.next/`.
    const marker = '/_next/';
    const index = pathname.indexOf(marker);
    if (index === -1) return null;

    const relative = pathname.slice(index + marker.length);
    if (!relative || relative.includes('..')) return null;

    const cwd = getNodeCwd();
    if (!cwd) return null;
    return `${cwd}/.next/${relative}`;
  }

  if (location.startsWith('/')) return location;

  // A bare relative path (webpack-internal:, node:, etc.) is not on disk.
  return null;
}

/**
 * Strip the bundler-specific prefixes maps put on their `sources` entries
 * and shorten to a cwd-relative path — `webpack://_N_E/./app/page.tsx`
 * and `[project]/app/page.tsx` both become `app/page.tsx`.
 */
function cleanSourcePath(source: string): string {
  let out = source;

  // Turbopack
  out = out.replace(/^\[project\]\//, '');
  // webpack, with or without the Next.js `_N_E` namespace
  out = out.replace(/^webpack:\/\/\/?(_N_E\/)?/, '');
  // esbuild/rollup occasionally emit these
  out = out.replace(/^(rsc:\/\/|turbopack:\/\/)/, '');
  out = out.replace(/^file:\/\//, '');
  out = out.replace(/^\.\//, '');

  const cwd = getNodeCwd();
  if (cwd && out.startsWith(cwd)) out = out.slice(cwd.length + 1);

  // Anything still absolute stays absolute — better a long true path than a
  // short wrong one.
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────

/** A generated position, as scraped out of a stack frame. */
export interface GeneratedPosition {
  /** File path or URL, exactly as the frame reported it. */
  file: string;
  /** 1-based, as stack traces report it. */
  line: number;
  /** 1-based, as stack traces report it. */
  column: number;
}

/** The original position, ready to print. */
export interface OriginalPosition {
  /** cwd-relative where possible (`app/checkout/page.tsx`). */
  file: string;
  line: number;
  column: number;
}

/**
 * Match the trailing `:line:col` (or just `:line`) of a location string and
 * capture the file part. Deliberately anchored at the end, because Windows
 * drive letters and `http://host:port` both contain colons earlier on.
 */
const LOCATION_RE = /^(.*?):(\d+)(?::(\d+))?$/;

/** Split `…/file.js:12:34` into its parts. */
export function parseLocation(location: string): GeneratedPosition | null {
  const match = LOCATION_RE.exec(location.trim());
  if (!match) return null;
  const line = Number(match[2]);
  if (!Number.isFinite(line)) return null;
  return {
    file: match[1]!,
    line,
    column: match[3] ? Number(match[3]) : 1,
  };
}

/**
 * Resolve a generated position to its original one, or `null` if no map
 * covers it.
 */
export function resolveOriginalPosition(
  position: GeneratedPosition,
): OriginalPosition | null {
  const diskPath = toDiskPath(position.file);
  if (!diskPath) return null;

  const map = loadMap(diskPath);
  if (!map) return null;

  // Source maps are 0-based on both axes; stack traces are 1-based.
  const segments = map.lines[position.line - 1];
  if (!segments) return null;

  const segment = findSegment(segments, Math.max(0, position.column - 1));
  if (!segment) return null;

  const source = map.sources[segment.sourceIndex];
  if (!source) return null;

  return {
    file: cleanSourcePath(source),
    line: segment.originalLine + 1,
    column: segment.originalColumn + 1,
  };
}

/**
 * Map a bare `file:line:col` string. Returns the input unchanged when
 * mapping is impossible, so callers can use it unconditionally.
 */
export function mapLocation(location: string): string {
  try {
    const position = parseLocation(location);
    if (!position) return location;
    const original = resolveOriginalPosition(position);
    if (!original) return location;
    return `${original.file}:${original.line}`;
  } catch {
    return location;
  }
}

/**
 * Map one stack frame in place, preserving everything around the location
 * (the `at`, the function name, the parentheses) so the frame still reads
 * like a stack frame.
 *
 *   at handleSubmit (https://app/_next/static/chunks/page.js:2:48219)
 *   → at handleSubmit (app/checkout/form.tsx:42:9)
 */
export function mapStackFrame(frame: string): string {
  try {
    // V8: `at fn (LOCATION)` / `at LOCATION`.  Safari/Firefox: `fn@LOCATION`.
    const parenthesised = /\(([^()]+)\)\s*$/.exec(frame);
    if (parenthesised) {
      const mapped = mapFrameLocation(parenthesised[1]!);
      return mapped === null
        ? frame
        : frame.slice(0, parenthesised.index) + `(${mapped})`;
    }

    const bare = /(?:^at\s+|@)(\S+)$/.exec(frame);
    if (bare) {
      const mapped = mapFrameLocation(bare[1]!);
      if (mapped === null) return frame;
      return frame.slice(0, bare.index + bare[0]!.length - bare[1]!.length) + mapped;
    }

    return frame;
  } catch {
    return frame;
  }
}

function mapFrameLocation(location: string): string | null {
  const position = parseLocation(location);
  if (!position) return null;
  const original = resolveOriginalPosition(position);
  if (!original) return null;
  return `${original.file}:${original.line}:${original.column}`;
}

/** Map every frame of a stack. Frames that cannot be mapped are kept as-is. */
export function mapStackFrames(frames: string[]): string[] {
  return frames.map(mapStackFrame);
}

/** Drop cached maps. Exported for tests and for HMR, where chunks change. */
export function _resetSourceMapCache(): void {
  mapCache.clear();
}
