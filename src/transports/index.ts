/**
 * @file transports/index.ts
 * Public entry point for the transport system:
 * `@developerehsan/nextjs-logger/transports`.
 *
 * Kept off the main entry deliberately. The adapters here reach for
 * `fetch`, `node:fs` and vendor-shaped payloads; an app that only wants
 * `log.info()` in its terminal should not carry any of it, and the main
 * entry is imported by Edge-eligible consumer files where a filesystem
 * dependency would be actively wrong.
 *
 * @example
 *   import { configureLogger } from '@developerehsan/nextjs-logger';
 *   import { datadogTransport, fileTransport } from
 *     '@developerehsan/nextjs-logger/transports';
 *
 *   configureLogger({
 *     transports: [
 *       fileTransport({ path: './logs/app.log' }),
 *       datadogTransport({ apiKey: process.env.DD_API_KEY!, minLevel: 'warn' }),
 *     ],
 *   });
 */

export type {
  Transport,
  LogTransport,
  TransportStats,
  FlushReason,
} from './types';
export { isBatchedTransport } from './types';

export {
  TransportPipeline,
  flushTransports,
  closeTransports,
  getTransportStats,
  type PipelineOptions,
} from './pipeline';

export { fileTransport, type FileTransportOptions } from './file';

export {
  httpTransport,
  defaultHttpFormat,
  datadogTransport,
  axiomTransport,
  betterStackTransport,
  type HttpTransportOptions,
  type VendorTransportOptions,
} from './http';

export { otlpTransport, type OtlpTransportOptions } from './otlp';

export { pinoTransport, winstonTransport } from './bridge';
