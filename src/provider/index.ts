/**
 * @file provider/index.ts
 * Subpath export: `@developerehsan/nextjs-logger/provider`
 *
 * Kept separate from the main entry so that consumers who only need
 * server-side logging (e.g. a standalone Node script, a cron job, a
 * non-Next.js backend reusing the core logger) don't pull in React/JSX
 * as a dependency.
 */

export { LoggerProvider } from './LoggerProvider';
export type { LoggerProviderProps } from './LoggerProvider';
// Re-exported through the `'use client'` island so the hook keeps its client
// boundary in the build output — see the header of ./client.ts.
export { useLogger } from './client';
