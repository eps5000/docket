/**
 * @tasklite/shared: definitions the server, the MCP adapter and the UI must
 * agree on byte for byte (BUILD_SPEC §13): enums, errors, write checks, the
 * MCP contract (tool schemas, copy and compact renderers).
 */
export const APP_NAME = 'Task Lite';

export * from './enums.js';
export * from './errors.js';
export * from './secrets.js';
export * from './mcp/index.js';
export * from './mcp-copy.js';
