/**
 * @file app/actions.ts
 * Server Actions demonstrating:
 *  - A namespaced logger via `createLogger` for a specific module.
 *  - try/catch error logging around real work.
 *  - Logging structured `data` that includes secret-shaped fields
 *    (password) to show the automatic redaction feature — check the
 *    terminal after submitting the form and the password value will read
 *    `[REDACTED]`, never the real value.
 */
'use server';

import { createLogger } from '@developerehsan/nextjs-logger';

const authLog = createLogger({ namespace: 'auth' });

export interface SubmitResult {
  ok: boolean;
  message: string;
}

export async function submitLogin(formData: FormData): Promise<SubmitResult> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  // `password` is redacted by the library's default `redactKeys` before it
  // ever reaches the terminal — no manual scrubbing needed here.
  authLog.info('Login attempt received', { email, password });

  try {
    if (!email.includes('@')) {
      throw new Error('Invalid email address');
    }

    authLog.info('Login attempt succeeded', { email });
    return { ok: true, message: `Welcome, ${email}` };
  } catch (err) {
    authLog.error('Login attempt failed', {
      email,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, message: err instanceof Error ? err.message : 'Login failed' };
  }
}
