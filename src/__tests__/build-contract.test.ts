/**
 * @file src/__tests__/build-contract.test.ts
 *
 * Regression tests for the bug class that unit tests structurally cannot
 * catch: the SOURCE is correct, but the BUILD OUTPUT loses a React Server
 * Component directive or duplicates a stateful module.
 *
 * Two such bugs shipped:
 *
 *  1. `'use server'` ended up on a re-export barrel while `relayLogEntries`'s
 *     body was code-split into a shared chunk ⇒ Next never registered the
 *     Server Action ⇒ the client's preferred relay transport silently no-opped.
 *
 *  2. `'use client'` was dropped altogether, because tsup merged the Client
 *     Component (`LoggerBootstrapClient`) and the async Server Component
 *     (`LoggerProvider`) into one output file, which can only carry one
 *     prologue ⇒ Next never shipped the bootstrap to the browser ⇒
 *     `initClientLogger()` never ran there ⇒ `clientBootstrap` stayed null ⇒
 *     every browser-side `log.*()` call was buffered forever with no queue,
 *     no relay, no error, and nothing in the terminal. Server-side and Server
 *     Action logging kept working, which is what made it so hard to diagnose.
 *
 * This file has two halves:
 *
 *  • "the real build satisfies the contract" — runs the shared checker from
 *    scripts/check-build-contract.mjs against the actual dist/.
 *
 *  • "the checker actually catches each regression" — mutates a copy of dist/
 *    to re-introduce each historical bug and asserts the checker rejects it.
 *    Without these, the guard could silently rot into something that always
 *    passes, which is how we'd end up shipping bug #3.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error -- plain .mjs helper, intentionally not typed
import { checkBuildContract, leadingDirective } from '../../scripts/check-build-contract.mjs';

const REPO_ROOT = resolve(__dirname, '../..');
const DIST = join(REPO_ROOT, 'dist');

/** Copy the real dist/ to a temp dir so a test can corrupt it safely. */
function mutableDistCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nextjs-logger-dist-'));
  cpSync(DIST, dir, { recursive: true });
  return dir;
}

const patch = (dir: string, rel: string, fn: (src: string) => string): void => {
  const p = join(dir, rel);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
};

describe('build output — RSC directive contract', () => {
  beforeAll(() => {
    if (!existsSync(DIST)) {
      throw new Error(
        'dist/ is missing. These tests assert on the BUILD OUTPUT (that is the ' +
          'whole point — the bugs they guard against are invisible in src/). ' +
          'Run `npm run build` first.',
      );
    }
  });

  it('the real build satisfies every contract check', () => {
    expect(checkBuildContract(DIST)).toEqual([]);
  });

  it("ships 'use client' as the prologue of the client island", () => {
    const src = readFileSync(join(DIST, 'provider/client.js'), 'utf8');
    expect(leadingDirective(src)).toBe('use client');
  });

  it("ships 'use server' as the prologue of the Server Action island", () => {
    const src = readFileSync(join(DIST, 'relay/server-action.js'), 'utf8');
    expect(leadingDirective(src)).toBe('use server');
  });

  it('keeps the async Server Component entry free of any directive', () => {
    // A directive here would mean LoggerProvider and LoggerBootstrapClient got
    // merged again — the exact shape of bug #2.
    const src = readFileSync(join(DIST, 'provider/index.js'), 'utf8');
    expect(leadingDirective(src)).toBeNull();
  });

  it("routes LoggerBootstrapClient through './client' so the boundary is in the graph", () => {
    // Passing the directive check is not enough: if esbuild hoists the
    // component into a shared chunk, provider/index.js imports it from there,
    // the directive-bearing barrel becomes dead code, and the boundary is
    // never crossed.
    const src = readFileSync(join(DIST, 'provider/index.js'), 'utf8');
    expect(src).toMatch(/from\s*['"]\.\/client['"]/);
  });

  it("keeps relayLogEntries's body in the 'use server' file, not a re-export", () => {
    const src = readFileSync(join(DIST, 'relay/server-action.js'), 'utf8');
    expect(src).toMatch(/function relayLogEntries\b/);
  });

  it('emits core/logger.ts exactly once so its module state is a single instance', () => {
    // clientBootstrap / preInitBuffer / globalConfig live here. A second copy
    // breaks client bootstrap AND configureLogger() reaching the relay
    // handlers, both silently.
    const fingerprint = 'Client logger used before initClientLogger() was called.';
    const owners = ['index.js', 'core/logger.js', 'provider/index.js', 'provider/client.js', 'relay/route-handler.js', 'relay/server-action.js']
      .filter((rel) => readFileSync(join(DIST, rel), 'utf8').includes(fingerprint));
    // The entries themselves should all delegate to the shared chunk.
    expect(owners).toEqual([]);
  });

  it('does not let the relay handlers build their own config', () => {
    for (const rel of ['relay/server-action.js', 'relay/route-handler.js']) {
      const src = readFileSync(join(DIST, rel), 'utf8');
      expect(src, `${rel} must read shared config via getConfig()`).not.toMatch(
        /function buildDefaultConfig\b/,
      );
    }
  });
});

describe('build output — the guard itself catches each historical regression', () => {
  it("catches a stripped 'use client' directive (bug #2)", () => {
    const dir = mutableDistCopy();
    patch(dir, 'provider/client.js', (s) => s.replace(/^["']use client["'];?/m, ''));
    expect(checkBuildContract(dir).join('\n')).toMatch(/must start with a 'use client'/);
  });

  it("catches a stripped 'use server' directive (bug #1)", () => {
    const dir = mutableDistCopy();
    patch(dir, 'relay/server-action.js', (s) => s.replace(/^["']use server["'];?/m, ''));
    expect(checkBuildContract(dir).join('\n')).toMatch(/must start with a 'use server'/);
  });

  it('catches a Server Action degraded to a re-export barrel (bug #1, exact shape)', () => {
    const dir = mutableDistCopy();
    patch(dir, 'relay/server-action.js', () =>
      `'use server';\nimport { relayLogEntries } from '../chunk-XXXX.js';\nexport { relayLogEntries };\n`,
    );
    expect(checkBuildContract(dir).join('\n')).toMatch(/function BODY, not just a re-export/);
  });

  it('catches the client boundary being bypassed via a shared chunk', () => {
    const dir = mutableDistCopy();
    patch(dir, 'provider/index.js', (s) =>
      s.replace(/from\s*['"]\.\/client['"]/g, 'from "../chunk-BYPASS.js"'),
    );
    expect(checkBuildContract(dir).join('\n')).toMatch(/must import from '\.\/client'/);
  });

  it("catches a 'use client' directive leaking onto the Server Component entry", () => {
    const dir = mutableDistCopy();
    patch(dir, 'provider/index.js', (s) => `'use client';\n${s}`);
    expect(checkBuildContract(dir).join('\n')).toMatch(/must NOT have a 'use client' directive/);
  });

  it('catches core/logger.ts being duplicated into a standalone island', () => {
    const dir = mutableDistCopy();
    // Simulate a `splitting: false` island inlining its own private copy.
    patch(dir, 'relay/server-action.js', (s) =>
      `${s}\nfunction __inlinedCopy(){throw new Error("[logger] Client logger used before initClientLogger() was called.")}\n`,
    );
    expect(checkBuildContract(dir).join('\n')).toMatch(/is duplicated across 2 emitted files/);
  });

  it('catches a relay handler building its own config', () => {
    const dir = mutableDistCopy();
    patch(dir, 'relay/route-handler.js', (s) => `${s}\nfunction buildDefaultConfig(){return {}}\n`);
    expect(checkBuildContract(dir).join('\n')).toMatch(/defines its own buildDefaultConfig/);
  });

  it('reports a missing dist/ rather than silently passing', () => {
    expect(checkBuildContract(join(tmpdir(), 'definitely-not-a-dist-dir-xyz')).join('\n')).toMatch(
      /dist\/ not found/,
    );
  });
});

describe('leadingDirective — prologue detection rules', () => {
  it('sees through the BOM, whitespace, and line/block comments', () => {
    expect(leadingDirective('"use client";')).toBe('use client');
    expect(leadingDirective("'use client';")).toBe('use client');
    expect(leadingDirective('\n\n  "use client";')).toBe('use client');
    expect(leadingDirective('// hi\n"use client";')).toBe('use client');
    expect(leadingDirective('/* block\n * comment\n */\n"use client";')).toBe('use client');
    expect(leadingDirective('﻿"use client";')).toBe('use client');
    expect(leadingDirective('/*a*/ // b\n /*c*/ "use server";')).toBe('use server');
  });

  it('rejects a directive that is not the first statement', () => {
    // This is the real-world failure: the string is present in the file, but
    // after an import, so it is a no-op expression rather than a prologue.
    expect(leadingDirective('import x from "y";\n"use client";')).toBeNull();
    expect(leadingDirective('const a = 1;\n"use client";')).toBeNull();
    expect(leadingDirective('// only a comment\n')).toBeNull();
    expect(leadingDirective('')).toBeNull();
  });
});
