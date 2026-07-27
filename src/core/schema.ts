/**
 * @file core/schema.ts
 * Optional validation of a log entry's `data` against a schema, per
 * namespace — so structured logs stay queryable instead of drifting.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 * Structured logging's whole value is that `data` has a stable shape you
 * can query on. Nothing enforces that. Six months in, `checkout` events
 * carry `orderId` in some places, `order_id` in others, and `id` in the
 * ones written during an incident — and every dashboard built on them is
 * quietly wrong. The failure is invisible at write time and expensive at
 * read time, which is the worst possible combination.
 *
 * ── Standard Schema, so this needs no dependency and no favourites ───────
 * Validation goes through the [Standard Schema](https://standardschema.dev)
 * spec — a tiny interface that Zod 3.24+, Valibot, ArkType and others all
 * implement natively. The consequence is that this file imports nothing,
 * and the app brings whichever validator it already uses. A plain predicate
 * function is also accepted, for someone who wants one field checked and no
 * library at all.
 *
 * ── What a failure does ──────────────────────────────────────────────────
 * **Never throws, and never drops the log line.** A validation failure is a
 * bug in the *logging call*, and the response to that must not be to
 * discard the evidence — the entry goes through either way, annotated with
 * `data.__schemaError`. The default mode warns in development and stays
 * silent in production, because a violation is worth interrupting a
 * developer for and never worth adding noise to an incident.
 */

import type { LogEntry } from './types';

/**
 * The Standard Schema v1 interface, declared structurally.
 *
 * Copied rather than imported: `@standard-schema/spec` is a types-only
 * package, and adding a dependency to describe an interface that exists
 * precisely so it need not be depended on would be self-defeating.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

interface StandardSchemaResult<Output> {
  readonly value?: Output;
  readonly issues?: ReadonlyArray<{
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
  }>;
}

/** A validator: a Standard Schema, or a predicate returning true / an error string. */
export type DataSchema =
  | StandardSchemaV1
  | ((data: unknown) => boolean | string);

/** What to do when `data` does not match. */
export type SchemaViolationMode =
  /** Warn on the process console; log the entry anyway. Default in development. */
  | 'warn'
  /** Annotate the entry with `__schemaError` and log it. Default in production. */
  | 'annotate'
  /** Do nothing at all. */
  | 'ignore';

export interface SchemaRegistration {
  /** Namespace this applies to. Child namespaces inherit it. */
  namespace: string;
  schema: DataSchema;
  mode?: SchemaViolationMode;
}

/**
 * Registered schemas, most-recently-registered first so a later, more
 * specific registration wins over an earlier general one.
 */
let registrations: SchemaRegistration[] = [];

/**
 * Require `data` to match `schema` for entries in `namespace` (and its
 * children).
 *
 * @example
 *   import { z } from 'zod';
 *   registerSchema('checkout', z.object({
 *     orderId: z.string(),
 *     amountCents: z.number().int(),
 *   }));
 *
 *   log.child('checkout').info('order placed', { orderId: 'o_1', amountCents: 500 });
 *   log.child('checkout').info('order placed', { order_id: 'o_1' }); // ⚠ warns
 */
export function registerSchema(
  namespace: string,
  schema: DataSchema,
  mode?: SchemaViolationMode,
): void {
  registrations = [{ namespace, schema, mode }, ...registrations];
}

/** Drop every registered schema. */
export function clearSchemas(): void {
  registrations = [];
}

/** True if any schema is registered — the fast exit on the log path. */
export function hasSchemas(): boolean {
  return registrations.length > 0;
}

function findRegistration(namespace: string | undefined): SchemaRegistration | undefined {
  if (!namespace) return undefined;
  return registrations.find(
    (registration) =>
      namespace === registration.namespace ||
      namespace.startsWith(`${registration.namespace}:`),
  );
}

/** Render a Standard Schema issue path as `a.b[0].c`. */
function formatPath(
  path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined,
): string {
  if (!path?.length) return '(root)';
  return path
    .map((segment) => {
      const key = typeof segment === 'object' && segment !== null ? segment.key : segment;
      return typeof key === 'number' ? `[${key}]` : String(key);
    })
    .join('.');
}

/**
 * Validate an entry's `data`, returning a human-readable problem
 * description or `undefined` when it is fine.
 *
 * Synchronous by necessity: this runs inside `dispatch()`, which is
 * synchronous all the way to the terminal write. A Standard Schema
 * validator is *allowed* to be async (Zod's `.refine` with a promise, for
 * instance), and there is nowhere to await it here — so an async result is
 * skipped rather than blocking, floating, or silently passing. That
 * limitation is real, and it is the right trade: making the log path async
 * to accommodate a database-backed refinement inside a *log schema* would
 * be an absurd tail wagging an absurd dog.
 */
export function validateEntryData(entry: LogEntry): string | undefined {
  const registration = findRegistration(entry.context.namespace);
  if (!registration) return undefined;

  const { schema } = registration;

  try {
    if (typeof schema === 'function') {
      const result = schema(entry.data);
      if (result === true) return undefined;
      return typeof result === 'string' ? result : 'data failed the registered predicate';
    }

    const validate = schema['~standard']?.validate;
    if (typeof validate !== 'function') return undefined;

    const result = validate(entry.data);

    // A promise means an async validator — see the docblock.
    if (result instanceof Promise || typeof (result as PromiseLike<unknown>)?.then === 'function') {
      return undefined;
    }

    const issues = (result as StandardSchemaResult<unknown>).issues;
    if (!issues?.length) return undefined;

    return issues
      .slice(0, 5)
      .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
      .join('; ');
  } catch (error) {
    // A throwing validator must not take down the log call it was meant to
    // improve.
    return `schema threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Apply the configured violation mode to an entry, in place.
 *
 * Returns the entry either way — a schema violation never suppresses a log
 * line. The one thing worse than an inconsistently-shaped log is a missing
 * one.
 */
export function applySchemaValidation(entry: LogEntry, isDev: boolean): LogEntry {
  if (!hasSchemas()) return entry;

  const problem = validateEntryData(entry);
  if (!problem) return entry;

  const registration = findRegistration(entry.context.namespace);
  const mode = registration?.mode ?? (isDev ? 'warn' : 'annotate');

  if (mode === 'ignore') return entry;

  if (mode === 'warn') {
    // The process console, not the logger — routing this through `log`
    // would re-enter `dispatch` and, for a schema attached to the same
    // namespace, recurse.
    console.warn(
      `[logger] Log data for namespace "${entry.context.namespace}" does not match its ` +
        `registered schema — ${problem}. The entry was logged anyway.`,
    );
  }

  return {
    ...entry,
    data:
      entry.data === undefined || typeof entry.data !== 'object' || entry.data === null
        ? { __schemaError: problem, value: entry.data }
        : { ...(entry.data as Record<string, unknown>), __schemaError: problem },
  };
}
