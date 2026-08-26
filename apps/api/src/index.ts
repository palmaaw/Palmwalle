/**
 * @palma/api public surface: composition root + app factory for embedding
 * (CLI seeder, smoke/e2e harnesses). The actual listener lives in main.ts.
 *
 * ⚠️ PROTOTYPE: simulated wallet + simulated biometrics. No real transfers.
 */

export { loadConfig } from './config.js';
export type { AppConfig } from './config.js';
export { buildContext } from './container.js';
export type { AppContext } from './container.js';
export { buildApp } from './server.js';
export { hashPin, verifyPin } from './security/passwordHash.js';
