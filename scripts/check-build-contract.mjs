/**
 * @file scripts/check-build-contract.mjs
 *
 * Guards the React Server Component contract of the BUILD OUTPUT.
 *
 * Why this exists: the library's source has always been correct. Two separate
 * shipped bugs were caused purely by how tsup/esbuild *emitted* it, and no
 * amount of unit testing against `src/` could ever have caught either one:
 *
 *  1. `'use server'` was dropped from the file that defines `relayLogEntries`
 *     (the body got code-split into a shared chunk, leaving the directive on a
 *     re-export barrel). Next never registered the Server Action, so the
 *     client's preferred relay transport silently no-opped.
 *
 *  2. `'use client'` was dropped entirely, because tsup merged the Client
 *     Component (`LoggerBootstrapClient`) and the async Server Component
 *     (`LoggerProvider`) into one output file, which can only have one
 *     prologue. Next therefore never shipped the bootstrap component to the
 *     browser, `initClientLogger()` never ran there, and EVERY browser-side
 *     `log.*()` call was buffered forever with no queue, no relay, no error,
 *     and nothing in the terminal — while server-side logging kept working
 *     perfectly, which is what made it so confusing to diagnose.
 *
 * Both failures are invisible in source review, produce no error at runtime,
 * and only manifest as "logs silently don't appear". So they are checked here,
 * against the real artifact, and this runs as part of `postbuild` so a broken
 * artifact can never be published. `src/__tests__/build-contract.test.ts`
 * imports these same checks so `npm test` covers them too.
 *
 * Run directly: `node scripts/check-build-contract.mjs`
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A string literal that exists only in `src/core/logger.ts`. Used as a
 * fingerprint to detect whether that module was duplicated across emitted
 * files. Chosen over an identifier name because bundlers rename identifiers
 * but never rewrite string literals.
 *
 * If you change this message in core/logger.ts, update it here too.
 */
const CORE_LOGGER_FINGERPRINT =
  'Client logger used before initClientLogger() was called.';

/**
 * Return the file's leading directive (`'use client'` / `'use server'`), or
 * null. A directive only counts when it is the very first *statement*, so we
 * step over the BOM, whitespace, and any leading comments first — that's
 * exactly the rule esbuild and Next.js's compiler apply.
 */
export function leadingDirective(source) {
  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1; // BOM

  for (;;) {
    // whitespace
    while (i < source.length && /\s/.test(source[i])) i++;
    // line comment
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      if (nl === -1) return null;
      i = nl + 1;
      continue;
    }
    // block comment
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    break;
  }

  const m = /^(['"])(use client|use server)\1\s*;?/.exec(source.slice(i));
  return m ? m[2] : null;
}

/** Every emitted `.js` file, relative to dist. */
function listEmittedJs(distDir) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) walk(join(dir, name.name), rel);
      else if (name.name.endsWith('.js')) out.push(rel);
    }
  };
  walk(distDir, '');
  return out.sort();
}

/**
 * Run every build-output contract check.
 * @returns {string[]} human-readable violations; empty means the build is sound.
 */
export function checkBuildContract(distDir = join(REPO_ROOT, 'dist')) {
  const violations = [];

  if (!existsSync(distDir)) {
    return [`dist/ not found at ${distDir} — run \`npm run build\` first.`];
  }

  const read = (rel) => {
    const p = join(distDir, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  const need = (rel) => {
    const src = read(rel);
    if (src === null) violations.push(`missing expected build output: dist/${rel}`);
    return src;
  };

  const clientIsland = need('provider/client.js');
  const providerIndex = need('provider/index.js');
  const serverAction = need('relay/server-action.js');
  const routeHandler = need('relay/route-handler.js');
  const coreBarrel = need('core/logger.js');
  const mainIndex = need('index.js');

  // ── 1. The client island must carry a 'use client' prologue ──────────────
  // Without this, Next never registers it as a client module, the bootstrap
  // renders server-side only, and ALL browser logging silently dies.
  if (clientIsland !== null) {
    const d = leadingDirective(clientIsland);
    if (d !== 'use client') {
      violations.push(
        `dist/provider/client.js must start with a 'use client' directive (found: ${
          d ? `'${d}'` : 'none'
        }). Without it Next.js will not ship the logger bootstrap to the ` +
          `browser and every client-side log.*() call is silently dropped.`,
      );
    }
  }

  // ── 2. The Server Action island must carry a 'use server' prologue ───────
  if (serverAction !== null) {
    const d = leadingDirective(serverAction);
    if (d !== 'use server') {
      violations.push(
        `dist/relay/server-action.js must start with a 'use server' directive (found: ${
          d ? `'${d}'` : 'none'
        }). Without it Next.js will not register relayLogEntries as a Server ` +
          `Action and the client's preferred relay transport silently no-ops.`,
      );
    }
  }

  // ── 3. ...and the Server Action's BODY must live in that same file ───────
  // A directive on a file that merely re-exports the action does NOT work:
  // Next instruments the function where the directive applies, so a
  // re-export leaves the real function uninstrumented. This is precisely how
  // bug #1 shipped.
  if (serverAction !== null && !/function relayLogEntries\b/.test(serverAction)) {
    violations.push(
      `dist/relay/server-action.js must contain relayLogEntries's function ` +
        `BODY, not just a re-export. Next.js instruments the action in the ` +
        `module where 'use server' applies; a re-export barrel leaves the ` +
        `real function uninstrumented and it will never be registered.`,
    );
  }

  // ── 4. provider/index.js must NOT carry a directive ──────────────────────
  // It holds the async Server Component `LoggerProvider`. A 'use client'
  // prologue here is the exact mistake that forces the two components into
  // one file and loses the boundary.
  if (providerIndex !== null) {
    const d = leadingDirective(providerIndex);
    if (d !== null) {
      violations.push(
        `dist/provider/index.js must NOT have a '${d}' directive — it holds ` +
          `the async Server Component LoggerProvider. The client boundary ` +
          `belongs in dist/provider/client.js.`,
      );
    }
  }

  // ── 5. The client boundary must actually be in the import graph ──────────
  // If esbuild hoists LoggerBootstrapClient into a shared chunk, provider/
  // index.js imports it straight from that chunk and the directive-bearing
  // barrel becomes dead code nobody imports — so the boundary is never
  // crossed and browser logging dies exactly as before, even though check #1
  // still passes. This is a real failure mode that was hit while fixing bug #2.
  if (providerIndex !== null && !/from\s*['"]\.\/client['"]/.test(providerIndex)) {
    violations.push(
      `dist/provider/index.js must import from './client' so the 'use client' ` +
        `boundary is in the import graph. It currently bypasses ` +
        `dist/provider/client.js (likely importing LoggerBootstrapClient from ` +
        `a shared chunk instead), which makes that file dead code and loses ` +
        `the client boundary. Keep './client' in tsup's \`external\` list.`,
    );
  }

  // ── 6. core/logger.ts must exist in exactly ONE emitted file ─────────────
  // It owns mutable module state: clientBootstrap, preInitBuffer, globalConfig.
  //   • Two copies ⇒ initClientLogger() writes one, dispatch() reads the other
  //     ⇒ the browser buffers every log forever (indistinguishable from bug #2).
  //   • Two copies ⇒ configureLogger() no longer reaches the relay handlers
  //     ⇒ silent prettyPrint/redactKeys divergence.
  // A `splitting: false` island inlines its own private copy, which is how
  // this invariant gets broken.
  const owners = listEmittedJs(distDir).filter((rel) =>
    readFileSync(join(distDir, rel), 'utf8').includes(CORE_LOGGER_FINGERPRINT),
  );
  if (owners.length !== 1) {
    violations.push(
      owners.length === 0
        ? `could not locate core/logger.ts in any emitted file (fingerprint ` +
            `"${CORE_LOGGER_FINGERPRINT}" not found). If you reworded that ` +
            `message, update CORE_LOGGER_FINGERPRINT in this script.`
        : `core/logger.ts is duplicated across ${owners.length} emitted ` +
            `files: ${owners.join(', ')}. It owns mutable module state ` +
            `(clientBootstrap / preInitBuffer / globalConfig) and MUST be a ` +
            `single shared instance. Mark '../core/logger' external in any ` +
            `\`splitting: false\` build instead of letting it inline a copy.`,
    );
  }

  // ── 7. The relay handlers must read the SHARED config ────────────────────
  // Both must reach globalConfig through core/logger, never build their own.
  for (const [rel, src] of [
    ['relay/server-action.js', serverAction],
    ['relay/route-handler.js', routeHandler],
  ]) {
    if (src === null) continue;
    if (/function buildDefaultConfig\b/.test(src)) {
      violations.push(
        `dist/${rel} defines its own buildDefaultConfig() — it must read ` +
          `config via getConfig() from the shared core/logger instance, or ` +
          `configureLogger() silently won't reach it (prettyPrint/redactKeys ` +
          `diverge between direct and relayed logs).`,
      );
    }
  }

  // ── 8. Sanity: the public entries resolve ────────────────────────────────
  if (coreBarrel !== null && mainIndex !== null) {
    for (const [rel, src] of [
      ['core/logger.js', coreBarrel],
      ['index.js', mainIndex],
    ]) {
      if (src.trim() === '') violations.push(`dist/${rel} is empty`);
    }
  }

  return violations;
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const violations = checkBuildContract();
  if (violations.length > 0) {
    console.error(
      `\n[check-build-contract] ${violations.length} RSC build-contract violation(s):\n`,
    );
    for (const v of violations) console.error(`  ✗ ${v}\n`);
    process.exit(1);
  }
  console.log('[check-build-contract] OK — RSC directives and module-state invariants hold.');
}
