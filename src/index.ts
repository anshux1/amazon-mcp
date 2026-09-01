/**
 * Shopping MCP server entry point.
 *
 * NitroStack selects stdio, HTTP, or dual transport from MCP_TRANSPORT_TYPE;
 * otherwise it uses stdio in development and dual transport in production.
 */

import 'dotenv/config';
import { McpApplicationFactory } from '@nitrostack/core';
import { AppModule } from './app.module.js';

/** Start and serve the shopping MCP application. */
async function bootstrap() {
  // Create and start the MCP server
  const server = await McpApplicationFactory.create(AppModule);
  await server.start();
}

// Start the application
bootstrap().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
