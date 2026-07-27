import type { NextConfig } from "next";

// Note: `transpilePackages: ["@developerehsan/nextjs-logger"]` is deliberately
// NOT needed. The package ships its `'use client'` / `'use server'` boundaries
// as real, directive-bearing entry files, so Next.js picks them up straight out
// of node_modules — verified against a packed `npm pack` install, not just the
// workspace symlink. If you ever find yourself reaching for transpilePackages
// to make client-side logging work, the real problem is a broken build
// artifact; see "RSC build contract" in the repo's CLAUDE.md.
const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
