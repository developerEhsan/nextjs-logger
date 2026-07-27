#!/usr/bin/env node
/**
 * Fails the build if the compiled `dist/` output contains a literal
 * reference to a Node.js-only API that Next.js's Edge Runtime build
 * scanner flags (e.g. `process.stdout`, `process.cwd(`, `Buffer.from`).
 *
 * This is a static text/regex scan, not a real Edge Runtime execution —
 * intentionally, since the actual bug class this guards against is a
 * *literal token* appearing in a chunk that could be pulled into an
 * Edge-bundled consumer app, not a runtime crash (runtime safety is
 * already covered by `isServer()`/`isEdgeRuntime()` guards and the
 * indirect accessors in `src/utils/node-globals.ts`). Run after every
 * build (see the `postbuild` script in package.json) so a future change
 * that reintroduces a direct `process.stdout` etc. reference fails CI
 * immediately instead of surfacing as a "Node.js API is used" warning in
 * some consumer's `next dev`/`next build` output.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST_DIR = new URL('../dist', import.meta.url).pathname;

// Each pattern targets the literal member-expression form Next.js's
// scanner matches — not the API name in the abstract (`Buffer` alone is
// fine, e.g. as a TypeScript type import; `Buffer.from(` as a call isn't).
const FORBIDDEN_PATTERNS = [
  { name: 'process.stdout', re: /\bprocess\.stdout\b/ },
  { name: 'process.stderr', re: /\bprocess\.stderr\b/ },
  { name: 'process.cwd(', re: /\bprocess\.cwd\s*\(/ },
  { name: 'Buffer.from(', re: /\bBuffer\.from\s*\(/ },
  { name: 'require(', re: /\brequire\s*\(\s*['"]/ },
  // A resolvable `node:` specifier — static or dynamic. `utils/source-map.ts`
  // needs `node:fs` for synchronous map reads, and reaches it two ways that
  // are both invisible to a bundler: `process.getBuiltinModule('node:fs')`
  // (a plain function argument, matched by neither pattern below) and a
  // dynamic import whose specifier is assembled at runtime. Both patterns
  // exist because `'node:' + 'fs'` is constant-folded by esbuild — if
  // someone "simplifies" the runtime assembly back to a literal, the
  // specifier becomes resolvable again and Next's Edge bundler starts
  // flagging it in any consumer chunk that reaches this module.
  { name: 'static node: import', re: /\bfrom\s*['"]node:/ },
  { name: 'literal node: dynamic import', re: /\bimport\s*\(\s*['"]node:/ },
];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (entry.endsWith('.js')) files.push(full);
  }
  return files;
}

let files;
try {
  files = walk(DIST_DIR);
} catch (err) {
  console.error(`[check-edge-safety] Could not read dist/ — did the build run? (${err.message})`);
  process.exit(1);
}

let failed = false;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    if (re.test(source)) {
      failed = true;
      console.error(`[check-edge-safety] Forbidden literal "${name}" found in ${file}`);
    }
  }
}

if (failed) {
  console.error(
    '\n[check-edge-safety] Found direct Node.js API references in dist/. These ' +
    'must go through the indirect accessors in src/utils/node-globals.ts so ' +
    "Next.js's Edge Runtime build scanner doesn't flag them in consumer apps.",
  );
  process.exit(1);
}

console.log(`[check-edge-safety] OK — scanned ${files.length} file(s), no forbidden Node.js API literals found.`);
