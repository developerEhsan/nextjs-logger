/**
 * @file core/errors.ts
 * First-class serialisation of `Error` objects.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `log.error(err)` is the single most common call any logger receives, and
 * until this module existed it was the one call this library got wrong:
 * `Error`'s interesting fields (`message`, `stack`, `name`) are all either
 * non-enumerable or on the prototype, so `JSON.stringify(err)` returns
 * `{}`. An error relayed from the browser therefore reached the terminal as
 * an empty object — the worst possible outcome for the highest-value log
 * line in the app.
 *
 * Serialisation here covers everything the platform can throw at us:
 *   • `message` / `name` / `stack` (stack split into frames — see below)
 *   • `cause` chains (ES2022), walked to `MAX_CAUSE_DEPTH`
 *   • `AggregateError.errors` (thrown by `Promise.any`, and by several
 *     Node APIs), each element serialised recursively
 *   • own enumerable extras — `code`, `statusCode`, `digest` (Next.js
 *     attaches this one to every Server Component error), and whatever
 *     else user-defined error subclasses carry
 *   • non-Error throws (`throw 'boom'`, `throw {code: 1}`), because those
 *     happen and must not crash the serialiser
 *
 * ── Frames as an array, not a string ─────────────────────────────────────
 * `stack` is split into an array of frame strings rather than kept as one
 * blob for two reasons. First, the terminal formatter must print each frame
 * on its own line with a prefix *we* control — a raw multi-line string
 * would be newline-escaped by `sanitiseMessage` (correctly: a relayed stack
 * is attacker-controlled text, and a real newline in it could forge a log
 * line). Second, source-map resolution operates per frame.
 *
 * ── Cycles ───────────────────────────────────────────────────────────────
 * `err.cause = err` is legal, and error subclasses that hold a reference to
 * a request/response object frequently produce cycles through the extras.
 * Every recursive path here is both depth-capped and `seen`-guarded.
 */

/** A JSON-safe representation of a thrown value. */
export interface SerializedError {
  /** Constructor name (`TypeError`, `PrismaClientKnownRequestError`, …). */
  name: string;
  message: string;
  /**
   * Stack frames, one per element, header line removed. Source-mapped at
   * write time on the server when `LoggerConfig.sourceMaps` is enabled.
   */
  stack?: string[];
  /** The `cause` chain (ES2022), already serialised. */
  cause?: SerializedError;
  /** `AggregateError.errors`, already serialised. */
  errors?: SerializedError[];
  /**
   * Own enumerable properties that are not `name`/`message`/`stack` —
   * `code`, `statusCode`, Next.js's `digest`, and anything a subclass adds.
   * Values are shallow JSON-safe (deeply serialised by `sanitiseData`
   * later); non-serialisable ones are dropped.
   */
  properties?: Record<string, unknown>;
}

/** How deep a `cause` chain is followed before it is truncated. */
const MAX_CAUSE_DEPTH = 5;

/** How many `AggregateError.errors` entries are serialised. */
const MAX_AGGREGATE_ERRORS = 10;

/** Frames kept per error. Deep stacks are noise; the top frames are the signal. */
const MAX_STACK_FRAMES = 30;

/** Own-property keys that are represented by dedicated fields above. */
const RESERVED_KEYS = new Set(['name', 'message', 'stack', 'cause', 'errors']);

/**
 * Is this value an `Error`?
 *
 * `instanceof Error` is necessary but not sufficient: an error that crossed
 * a realm boundary (a Node `vm` context, a worker, a structured-clone round
 * trip, or — the case that actually matters here — an error deserialised
 * from the relay payload) fails `instanceof` against *this* realm's `Error`.
 * So fall back to the internal class tag, then to a duck-type check.
 */
export function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (Object.prototype.toString.call(value) === '[object Error]') return true;
  const candidate = value as { name?: unknown; message?: unknown; stack?: unknown };
  return (
    typeof candidate.message === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.stack === 'string'
  );
}

/**
 * Split a `stack` string into frames.
 *
 * V8 prefixes the stack with `Name: message`, which can itself be
 * multi-line when the message is — so the header cannot be removed by
 * dropping a fixed number of lines. Frames are identified positively
 * instead: V8, SpiderMonkey and JavaScriptCore all produce lines that
 * either start with `at ` or contain an `@` location separator.
 */
function parseStack(stack: string | undefined): string[] | undefined {
  if (typeof stack !== 'string' || stack.length === 0) return undefined;

  const frames = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') || /@.+:\d+(?::\d+)?$/.test(line))
    .slice(0, MAX_STACK_FRAMES);

  return frames.length > 0 ? frames : undefined;
}

/** Collect own enumerable extras (`code`, `digest`, subclass fields, …). */
function collectProperties(
  err: object,
  seen: WeakSet<object>,
): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;

  for (const key of Object.keys(err)) {
    if (RESERVED_KEYS.has(key)) continue;

    let value: unknown;
    try {
      value = (err as Record<string, unknown>)[key];
    } catch {
      // A throwing getter on an error subclass must not take down the log.
      continue;
    }

    if (typeof value === 'function' || typeof value === 'symbol') continue;

    // A nested error inside an error's own properties (common in wrapper
    // errors that don't use `cause`) gets the same treatment as `cause`.
    if (isErrorLike(value)) {
      value = serializeErrorInner(value, seen, MAX_CAUSE_DEPTH - 1);
    } else if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) continue; // cycle — drop rather than recurse
    }

    (out ??= {})[key] = value;
  }

  return out;
}

function serializeErrorInner(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): SerializedError {
  // Non-Error throws: `throw 'boom'`, `throw { code: 500 }`, `throw null`.
  if (!isErrorLike(value)) {
    return {
      name: 'NonError',
      message: safeStringify(value),
      properties:
        typeof value === 'object' && value !== null
          ? collectProperties(value, seen)
          : undefined,
    };
  }

  const err = value as Error & { cause?: unknown; errors?: unknown };

  if (seen.has(err)) {
    return { name: err.name ?? 'Error', message: '[circular error reference]' };
  }
  seen.add(err);

  const out: SerializedError = {
    name: typeof err.name === 'string' && err.name ? err.name : 'Error',
    message: typeof err.message === 'string' ? err.message : safeStringify(err.message),
  };

  const frames = parseStack(err.stack);
  if (frames) out.stack = frames;

  if (depth > 0 && err.cause !== undefined && err.cause !== null) {
    out.cause = serializeErrorInner(err.cause, seen, depth - 1);
  }

  if (depth > 0 && Array.isArray(err.errors)) {
    out.errors = err.errors
      .slice(0, MAX_AGGREGATE_ERRORS)
      .map((inner) => serializeErrorInner(inner, seen, depth - 1));
  }

  const props = collectProperties(err, seen);
  if (props) out.properties = props;

  return out;
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Serialise any thrown value into a JSON-safe `SerializedError`.
 * Never throws — a logging call must not be the thing that crashes a
 * request that was already failing.
 */
export function serializeError(value: unknown): SerializedError {
  try {
    return serializeErrorInner(value, new WeakSet<object>(), MAX_CAUSE_DEPTH);
  } catch {
    return { name: 'Error', message: '[unserializable error]' };
  }
}

/**
 * A one-line summary suitable for a log entry's `message` when the caller
 * passed an error where a message was expected (`log.error(err)`).
 *
 * `name` is included because `err.message` alone routinely loses the most
 * diagnostic part of the line — "fetch failed" versus "TypeError: fetch
 * failed". It is skipped when the message already begins with it, which is
 * common for errors built by string concatenation.
 */
export function errorSummary(err: SerializedError): string {
  const name = err.name || 'Error';
  const message = err.message || '';
  if (!message) return name;
  if (message.startsWith(name)) return message;
  return `${name}: ${message}`;
}

/**
 * Replace any `Error` nested anywhere inside a structured `data` value with
 * its serialised form.
 *
 * Without this, `log.info('checkout failed', { attempt: 3, err })` prints
 * `"err": {}` — the same bug as the top-level case, just one level down,
 * and much easier to miss because the surrounding object looks fine.
 *
 * The walk is depth-capped and cycle-guarded, and returns the input
 * unchanged (same reference) when there is nothing to rewrite, so the
 * overwhelmingly common error-free path allocates nothing.
 */
export function normalizeErrorsDeep(data: unknown, depth = 6): unknown {
  return walk(data, depth, new WeakSet<object>());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (isErrorLike(value)) return serializeError(value);
  if (depth <= 0 || typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = walk(item, depth - 1, seen);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  // Only walk plain-ish objects. Class instances (a Prisma client, a
  // Request) are left alone — `sanitiseData`'s JSON round trip deals with
  // them, and recursing into arbitrary objects is how a logger ends up
  // dominating a flame graph.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    const next = walk(val, depth - 1, seen);
    if (next !== val) changed = true;
    // defineProperty rather than assignment: a `__proto__` key would
    // otherwise hit the inherited setter and reparent `out` instead of
    // being stored. Same reasoning as `redact()` in security/index.ts.
    Object.defineProperty(out, key, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return changed ? out : value;
}
