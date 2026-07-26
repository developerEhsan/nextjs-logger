// Ensures core/config.ts's deriveRelaySecret() (called eagerly at module
// load by core/logger.ts's `globalConfig` initializer) doesn't throw in the
// test environment, which has neither NODE_ENV=development nor a real
// production secret configured.
process.env.LOGGER_RELAY_SECRET ??= 'test-only-secret-at-least-32-characters!!';
