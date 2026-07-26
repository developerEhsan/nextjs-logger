/**
 * @file app/api/orders/route.ts
 * Demonstrates request-ID correlation: `proxy.ts` stamps every incoming
 * request with an `x-request-id` response header; here we read that same
 * ID back off the request and wrap the handler body in
 * `runWithRequestContext()` so every `log.*()` call made anywhere during
 * this request — including inside functions this handler calls — carries
 * the same `requestId` automatically, with no manual plumbing.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  createLogger,
  generateRequestId,
  runWithRequestContext,
} from '@developerehsan/nextjs-logger';

const ordersLog = createLogger({ namespace: 'orders' });

async function loadOrders() {
  // Simulates a downstream call; this log line inherits the request's ID
  // purely because it runs inside the runWithRequestContext() below —
  // no requestId parameter was threaded through.
  ordersLog.debug('Fetching orders from database');
  return [
    { id: 'ord_1', total: 42.5 },
    { id: 'ord_2', total: 17.0 },
  ];
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? generateRequestId();

  return runWithRequestContext(requestId, async () => {
    ordersLog.info('Listing orders');
    const orders = await loadOrders();
    ordersLog.info('Orders listed', { count: orders.length });

    return NextResponse.json({ requestId, orders });
  });
}
