/**
 * @file utils/__tests__/source-map.test.ts
 *
 * Real files on disk, real Source Map v3 mappings. The VLQ encoder below is
 * written independently of the decoder in `source-map.ts` — the point is to
 * check the decoder against the *spec*, and a shared helper would only
 * check it against itself.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'logger-sourcemap-'));

// `toDiskPath` resolves `/_next/…` browser URLs against the working
// directory, so the fixture build output has to live somewhere we control.
vi.mock('../node-globals', async () => {
  const actual = await vi.importActual<typeof import('../node-globals')>('../node-globals');
  return { ...actual, getNodeCwd: () => workDir };
});

const {
  mapLocation,
  mapStackFrame,
  resolveOriginalPosition,
  parseLocation,
  _resetSourceMapCache,
} = await import('../source-map');

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetSourceMapCache();
});

// ─── Minimal, independent VLQ encoder ────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    out += B64[digit];
  } while (vlq > 0);
  return out;
}

/** `[generatedCol, sourceIndex, originalLine, originalCol]`, all as deltas. */
function encodeSegment(fields: number[]): string {
  return fields.map(encodeVlq).join('');
}

interface Fixture {
  /** Path of the generated file written to disk. */
  generated: string;
}

/**
 * Write a generated file plus a sibling `.map`. `mappings` is given
 * per-generated-line as already-delta-encoded segments.
 */
function writeFixture(name: string, sources: string[], mappings: string): Fixture {
  const generated = join(workDir, name);
  mkdirSync(join(generated, '..'), { recursive: true });
  writeFileSync(generated, `console.log(1)\n//# sourceMappingURL=${name.split('/').pop()}.map\n`);
  writeFileSync(
    `${generated}.map`,
    JSON.stringify({ version: 3, sources, names: [], mappings }),
  );
  return { generated };
}

// ─── parseLocation ───────────────────────────────────────────────────────

describe('parseLocation', () => {
  it('splits file, line and column', () => {
    expect(parseLocation('/abs/chunk.js:12:34')).toEqual({
      file: '/abs/chunk.js',
      line: 12,
      column: 34,
    });
  });

  it('keeps the port in an http URL out of the line/column match', () => {
    // The trap: `http://localhost:3000/…` has colons long before the ones
    // that matter, so the pattern has to anchor at the end.
    expect(parseLocation('http://localhost:3000/_next/x.js:5:9')).toEqual({
      file: 'http://localhost:3000/_next/x.js',
      line: 5,
      column: 9,
    });
  });

  it('defaults a missing column', () => {
    expect(parseLocation('/abs/chunk.js:7')).toMatchObject({ line: 7, column: 1 });
  });

  it('returns null when there is no line number', () => {
    expect(parseLocation('/abs/chunk.js')).toBeNull();
  });
});

// ─── Mapping ─────────────────────────────────────────────────────────────

describe('resolveOriginalPosition', () => {
  it('maps a generated position back to the original source', () => {
    // One generated line, one segment: generated col 0 → source 0,
    // original line 41 (0-based → 42), original column 4 (→ 5).
    const { generated } = writeFixture(
      'chunk-a.js',
      ['../src/app/page.tsx'],
      encodeSegment([0, 0, 41, 4]),
    );

    expect(resolveOriginalPosition({ file: generated, line: 1, column: 1 })).toEqual({
      file: '../src/app/page.tsx',
      line: 42,
      column: 5,
    });
  });

  it('picks the nearest preceding segment on a minified line', () => {
    // Three segments at generated columns 0, 10 and 30, mapping to original
    // lines 1, 5 and 9. This is the case that matters in practice: every
    // frame in a minified bundle points into the middle of one long line.
    const mappings = [
      encodeSegment([0, 0, 0, 0]),
      encodeSegment([10, 0, 4, 0]),
      encodeSegment([20, 0, 4, 0]),
    ].join(',');
    const { generated } = writeFixture('chunk-b.js', ['app.ts'], mappings);

    expect(resolveOriginalPosition({ file: generated, line: 1, column: 15 })?.line).toBe(5);
    expect(resolveOriginalPosition({ file: generated, line: 1, column: 31 })?.line).toBe(9);
  });

  it('handles a multi-line mappings string', () => {
    const mappings = [
      encodeSegment([0, 0, 0, 0]),
      encodeSegment([0, 0, 2, 0]),
      encodeSegment([0, 0, 3, 0]),
    ].join(';');
    const { generated } = writeFixture('chunk-c.js', ['multi.ts'], mappings);

    expect(resolveOriginalPosition({ file: generated, line: 3, column: 1 })?.line).toBe(6);
  });

  it('returns null for a file with no map', () => {
    const bare = join(workDir, 'no-map.js');
    writeFileSync(bare, 'console.log(1)\n');
    expect(resolveOriginalPosition({ file: bare, line: 1, column: 1 })).toBeNull();
  });

  it('returns null rather than throwing on a corrupt map', () => {
    const generated = join(workDir, 'corrupt.js');
    writeFileSync(generated, 'x\n//# sourceMappingURL=corrupt.js.map\n');
    writeFileSync(`${generated}.map`, 'not json at all');
    expect(resolveOriginalPosition({ file: generated, line: 1, column: 1 })).toBeNull();
  });

  it('reads an inline base64 map', () => {
    const generated = join(workDir, 'inline.js');
    const map = JSON.stringify({
      version: 3,
      sources: ['inline-src.ts'],
      names: [],
      mappings: encodeSegment([0, 0, 6, 2]),
    });
    const encoded = Buffer.from(map, 'utf8').toString('base64');
    writeFileSync(
      generated,
      `x\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`,
    );

    expect(resolveOriginalPosition({ file: generated, line: 1, column: 1 })).toEqual({
      file: 'inline-src.ts',
      line: 7,
      column: 3,
    });
  });
});

// ─── Path handling ───────────────────────────────────────────────────────

describe('generated-path resolution', () => {
  it('maps a browser /_next/ URL onto the build output on disk', () => {
    // The whole point of the feature: a relayed browser frame names a URL,
    // not a file, and it still has to resolve.
    mkdirSync(join(workDir, '.next/static/chunks'), { recursive: true });
    writeFixture('.next/static/chunks/page.js', ['../app/checkout/form.tsx'],
      encodeSegment([0, 0, 41, 8]));

    const mapped = mapLocation('https://example.com/_next/static/chunks/page.js:1:1');
    expect(mapped).toBe('../app/checkout/form.tsx:42');
  });

  it('refuses to read outside the build output', () => {
    // Frame text arriving over the relay is attacker-influenced, so URL →
    // filesystem-path is the one place this module could be turned into an
    // arbitrary-read primitive. Only `/_next/` paths resolve at all.
    expect(mapLocation('https://example.com/etc/passwd:1:1')).toBe(
      'https://example.com/etc/passwd:1:1',
    );
  });

  it('strips bundler prefixes from the source path', () => {
    writeFixture('prefixed.js', ['webpack://_N_E/./app/page.tsx'], encodeSegment([0, 0, 0, 0]));
    expect(mapLocation(join(workDir, 'prefixed.js') + ':1:1')).toBe('app/page.tsx:1');

    _resetSourceMapCache();
    writeFixture('turbo.js', ['[project]/app/layout.tsx'], encodeSegment([0, 0, 2, 0]));
    expect(mapLocation(join(workDir, 'turbo.js') + ':1:1')).toBe('app/layout.tsx:3');
  });

  it('shortens an absolute source path to a cwd-relative one', () => {
    writeFixture('abs.js', [`${workDir}/app/thing.ts`], encodeSegment([0, 0, 0, 0]));
    expect(mapLocation(join(workDir, 'abs.js') + ':1:1')).toBe('app/thing.ts:1');
  });
});

// ─── Frame rewriting ─────────────────────────────────────────────────────

describe('mapStackFrame', () => {
  it('rewrites only the location, keeping the frame readable', () => {
    writeFixture('framed.js', ['app/form.tsx'], encodeSegment([0, 0, 9, 3]));
    const frame = `at handleSubmit (${join(workDir, 'framed.js')}:1:1)`;

    expect(mapStackFrame(frame)).toBe('at handleSubmit (app/form.tsx:10:4)');
  });

  it('rewrites a frame with no function name', () => {
    writeFixture('bare.js', ['app/util.ts'], encodeSegment([0, 0, 0, 0]));
    const frame = `at ${join(workDir, 'bare.js')}:1:1`;

    expect(mapStackFrame(frame)).toBe('at app/util.ts:1:1');
  });

  it('leaves an unmappable frame exactly as it was', () => {
    const frame = 'at processTicksAndRejections (node:internal/process/task_queues:105:5)';
    expect(mapStackFrame(frame)).toBe(frame);
  });

  it('never throws on malformed input', () => {
    expect(mapStackFrame('')).toBe('');
    expect(mapStackFrame('total nonsense')).toBe('total nonsense');
    expect(mapLocation('')).toBe('');
  });
});
