/**
 * @file app/api/boom/route.ts
 * Deliberately throws so the "Throw in a Route Handler" button on the
 * home page can demonstrate `instrumentation.ts`'s `onRequestError` hook —
 * the error is logged automatically, with no try/catch in this file.
 */
export async function GET() {
  throw new Error('Deliberate error for the onRequestError demo');
}
