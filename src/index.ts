/**
 * Shopping MCP server entry point.
 *
 * NitroStack uses the explicit MCP_TRANSPORT_TYPE configured by AppModule;
 * omitted values default to stdio in development and HTTP in production.
 */

import 'dotenv/config';
import { McpApplicationFactory } from '@nitrostack/core';
import { applyRuntimeDefaults } from './config/environment.js';

// Apply defaults before importing the root module. NitroStack reads transport
// settings directly from process.env, while ConfigModule handles validation.
applyRuntimeDefaults();

/** Start and serve the shopping MCP application. */
async function bootstrap() {
  // Load the root module inside the startup promise so configuration failures
  // are reported by the same safe bootstrap handler as server failures.
  const { AppModule } = await import('./app.module.js');
  const server = await McpApplicationFactory.create(AppModule);
  await server.start();
}

// Start the application
bootstrap().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
