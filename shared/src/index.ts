/**
 * @tasklite/shared: definitions the server, the MCP adapter and the UI must
 * agree on byte for byte (BUILD_SPEC §13): enums, errors and write checks.
 * MCP schemas, copy and renderers arrive in Phase 3.
 */
export const APP_NAME = 'Task Lite';

export * from './enums.js';
export * from './errors.js';
export * from './secrets.js';
