/**
 * @file app/logger-playground.tsx
 * Interactive demo of every client-facing logger feature. All of this
 * runs with zero `useEffect` — logging calls happen directly in event
 * handlers and even in the render body (see the `log.debug` call below),
 * because `<LoggerProvider>` (mounted once in `app/layout.tsx`) already
 * bootstrapped the relay transport before this component's first render.
 *
 * Open your terminal (not the browser DevTools console) to see the
 * output — that's the whole point of this package.
 */
'use client';

import { useState } from 'react';
import { log, createLogger } from '@developerehsan/nextjs-logger';
import { useLogger } from '@developerehsan/nextjs-logger/provider';
import { submitLogin, type SubmitResult } from './actions';

// A namespaced instance with its OWN minLevel/sampleRate, isolated from the
// default `log` singleton and unaffected by any later `configureLogger()`
// call — this is the createLogger() config-isolation fix in action.
const rapidLog = createLogger({ namespace: 'rapid-fire', minLevel: 'debug' });

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;

export function LoggerPlayground() {
  // Logging directly in the render body — safe even on the very first
  // render, because pre-init calls are buffered automatically.
  log.debug('LoggerPlayground rendered');

  const [loginResult, setLoginResult] = useState<SubmitResult | null>(null);
  const [ordersResult, setOrdersResult] = useState<string | null>(null);
  const [flushing, setFlushing] = useState(false);

  // useLogger() — an ergonomic, memoized namespaced logger for components
  // that already sit in hook-heavy code. Equivalent to `log.child('ui')`.
  const uiLog = useLogger('ui');

  return (
    <div className="flex flex-col gap-8 w-full max-w-2xl">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">1. Every level, one call each</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Each level uses its own TanStack Pacer strategy (throttle/debounce/rateLimit)
          before it reaches the terminal — see the README for the defaults.
        </p>
        <div className="flex flex-wrap gap-2">
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => log[level](`Manual ${level} log`, { clickedAt: Date.now() })}
              className="rounded-full border border-black/10 dark:border-white/20 px-4 py-2 text-sm capitalize hover:bg-black/5 dark:hover:bg-white/10"
            >
              {level}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">2. Rapid-fire (throttling demo)</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Fires 20 debug logs synchronously from an isolated <code>createLogger</code>{' '}
          instance. Watch the terminal: TanStack Pacer throttles the relay, so you won&apos;t
          see 20 separate network calls land at once.
        </p>
        <button
          onClick={() => {
            for (let i = 0; i < 20; i++) rapidLog.debug(`Rapid entry ${i}`);
          }}
          className="self-start rounded-full bg-foreground text-background px-4 py-2 text-sm"
        >
          Fire 20 debug logs
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">3. Redaction</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Logs an object containing a <code>password</code> field. Check the terminal —
          it prints <code>[REDACTED]</code>, never the real value.
        </p>
        <button
          onClick={() =>
            log.info('User profile updated', {
              email: 'demo@example.com',
              password: 'hunter2',
              bio: 'This part is not redacted.',
            })
          }
          className="self-start rounded-full border border-black/10 dark:border-white/20 px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
        >
          Log an object with a password field
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">4. useLogger() hook</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Same underlying logger, ergonomic hook form — prints with the{' '}
          <code>[ui]</code> namespace tag.
        </p>
        <button
          onClick={() => uiLog.info('Clicked via useLogger()')}
          className="self-start rounded-full border border-black/10 dark:border-white/20 px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
        >
          Log via useLogger(&apos;ui&apos;)
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">5. Manual flush</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The queue auto-flushes on a Pacer schedule and on tab close. This forces an
          immediate flush — useful right before a programmatic navigation.
        </p>
        <button
          onClick={async () => {
            setFlushing(true);
            log.warn('About to force-flush the client queue');
            await log.flush();
            setFlushing(false);
          }}
          disabled={flushing}
          className="self-start rounded-full border border-black/10 dark:border-white/20 px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50"
        >
          {flushing ? 'Flushing…' : 'log.flush()'}
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">6. Server Action + redaction</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Submits to a Server Action (<code>app/actions.ts</code>) using a namespaced{' '}
          <code>createLogger({'{'} namespace: &apos;auth&apos; {'}'})</code>. The password
          you type is logged server-side and redacted, exactly like #3.
        </p>
        <form
          action={async (formData) => setLoginResult(await submitLogin(formData))}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <input
            name="email"
            type="email"
            placeholder="you@example.com"
            required
            className="rounded-md border border-black/10 dark:border-white/20 bg-transparent px-3 py-2 text-sm"
          />
          <input
            name="password"
            type="password"
            placeholder="password"
            required
            className="rounded-md border border-black/10 dark:border-white/20 bg-transparent px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-full bg-foreground text-background px-4 py-2 text-sm whitespace-nowrap"
          >
            Submit
          </button>
        </form>
        {loginResult && (
          <p className={loginResult.ok ? 'text-sm text-green-600' : 'text-sm text-red-600'}>
            {loginResult.message}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">7. Request-ID correlation</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Calls <code>/api/orders</code>, a Route Handler that wraps its body in{' '}
          <code>runWithRequestContext()</code> — every log line it produces shares the
          same <code>requestId</code>, visible in the terminal output.
        </p>
        <button
          onClick={async () => {
            const res = await fetch('/api/orders');
            const data = await res.json();
            setOrdersResult(`requestId ${data.requestId} → ${data.orders.length} orders`);
          }}
          className="self-start rounded-full border border-black/10 dark:border-white/20 px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
        >
          Fetch /api/orders
        </button>
        {ordersResult && <p className="text-sm text-zinc-600 dark:text-zinc-400">{ordersResult}</p>}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">8. onRequestError</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Calls <code>/api/boom</code>, a Route Handler that always throws.
          <code>instrumentation.ts</code>&apos;s <code>onRequestError</code> hook logs it
          automatically — no try/catch anywhere in that route.
        </p>
        <button
          onClick={() => {
            fetch('/api/boom').catch(() => {
              /* expected: the response itself is a 500, this just avoids an unhandled rejection */
            });
          }}
          className="self-start rounded-full border border-red-300 dark:border-red-900 px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
        >
          Throw in a Route Handler
        </button>
      </section>
    </div>
  );
}
