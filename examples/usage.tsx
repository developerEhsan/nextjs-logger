/**
 * @file examples/usage.tsx
 * Demonstrates the core DX promise: call `log.X()` anywhere, no hooks.
 */

import { log } from '@developerehsan/nextjs-logger';

// ── 1. Server Component — logs straight to terminal, synchronously ──────────
export async function ServerComponentExample() {
  log.info('Rendering dashboard page', { route: '/dashboard' });

  const data = await fetch('https://api.example.com/data').then((r) => r.json());

  if (!data) {
    log.warn('Dashboard data fetch returned empty payload');
  }

  return <div>{JSON.stringify(data)}</div>;
}

// ── 2. Client Component — no useEffect required ─────────────────────────────
('use client');

export function ClientButtonExample() {
  // Logged directly inside the render body. Because the logger buffers
  // pre-init calls automatically, this is safe even if LoggerProvider's
  // bootstrap hasn't technically resolved on this exact tick.
  log.debug('ClientButtonExample rendered');

  function handleClick() {
    log.info('User clicked the CTA button', { ts: Date.now() });
  }

  return <button onClick={handleClick}>Click me</button>;
}

// ── 3. Server Action — automatic error logging ───────────────────────────────
('use server');

export async function submitForm(formData: FormData) {
  const email = formData.get('email');
  log.info('Form submission received', { email });

  try {
    // ... persist to DB ...
  } catch (err) {
    log.error('Form submission failed', { email, error: String(err) });
    throw err;
  }
}

// ── 4. Namespaced child logger for a specific module ─────────────────────────
import { createLogger } from '@developerehsan/nextjs-logger';

const authLog = createLogger({ namespace: 'auth' });

export async function loginHandler() {
  authLog.info('Login attempt started');
  // ...
}
