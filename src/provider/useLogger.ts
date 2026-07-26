/**
 * @file provider/useLogger.ts
 * Optional React hook for components that want an ergonomic, memoized
 * namespaced logger bound to the component's lifetime.
 *
 * This is NOT required — `log.info(...)` (or `log.child('ns')`) works
 * everywhere with zero hooks, which remains the primary DX of this
 * library. `useLogger` exists purely for components that already sit in
 * hook-heavy code and would rather grab a namespaced instance the same
 * way they grab everything else.
 */

'use client';

import { useMemo } from 'react';
import { log } from '../core/logger';
import type { Logger } from '../core/types';

/** Returns the default `log` singleton, or a memoized `log.child(namespace)`. */
export function useLogger(namespace?: string): Logger {
  return useMemo(() => (namespace ? log.child(namespace) : log), [namespace]);
}
