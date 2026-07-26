# nextjs-logger demo

A live, click-through demo of every `@developerehsan/nextjs-logger` feature, running on Next.js 16. Everything it produces goes to **this terminal**, not the browser DevTools console — that's the entire point of the package.

## Getting started

```bash
cp .env.local.example .env.local   # sets LOGGER_RELAY_SECRET for local dev
bun install                        # or npm install / pnpm install
bun dev                            # or npm run dev
```

Open [http://localhost:3000](http://localhost:3000), then watch **the terminal running `dev`**, not the browser console. Click through each numbered section on the page.

## What's wired up, and where

| Feature | File |
|---|---|
| Zero-hook client bootstrap | `app/layout.tsx` — `<LoggerProvider>` mounted once |
| Relay fallback API route | `app/api/__log/route.ts` |
| Server Action relay + namespaced logger | `app/actions.ts` |
| Request-ID correlation | `proxy.ts` + `app/api/orders/route.ts` |
| Uncaught error auto-logging | `instrumentation.ts` (`onRequestError`) |
| Global config: redaction, sampling, transports | `instrumentation.ts` (`register`, `configureLogger`) |
| Every level, rapid-fire/throttling, redaction, `useLogger()`, manual flush, Server Action form, request-ID fetch, error-throwing route | `app/logger-playground.tsx` |
| Server Component logging directly in render body | `app/page.tsx` |

## Try this

1. **Rapid-fire 20 debug logs** (section 2) — watch the terminal: TanStack Pacer throttles the relay, so you won't see 20 separate arrivals.
2. **Submit the login form** (section 6) with any password — the terminal prints `password: '[REDACTED]'`, never the real value.
3. **Fetch /api/orders** (section 7) — every log line from that request shares the same `requestId`, stamped by `proxy.ts` and threaded through `runWithRequestContext()`.
4. **Throw in a Route Handler** (section 8) — `/api/boom` throws with no try/catch; `instrumentation.ts`'s `onRequestError` logs it anyway.
5. Set `LOGGER_DEBUG_RELAY=1` in `.env.local` and restart — if you ever misconfigure `LOGGER_RELAY_SECRET`/origins, the terminal will tell you exactly why a relay request was rejected (the browser response stays a generic 4xx either way).

## Notes

This app depends on the package via a local path (`"@developerehsan/nextjs-logger": "../../"` in `package.json`), so it always demos whatever is currently in `../../src` after running `npm run build` at the repo root.
