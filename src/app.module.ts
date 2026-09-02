import 'dotenv/config';
import {
  ConfigModule,
  JWTModule,
  McpApp,
  Module,
} from '@nitrostack/core';
import { CommonModule } from './common/common.module.js';
import { HttpSecurityConfiguration } from './config/http-security.js';
import {
  applyRuntimeDefaults,
  assertValidEnvironment,
  type RuntimeDefaults,
} from './config/environment.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { ProductsModule } from './modules/products/products.module.js';

const runtimeDefaults: RuntimeDefaults = applyRuntimeDefaults();

JWTModule.forRoot({
  secretEnvVar: 'JWT_SECRET',
  expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  audience: process.env.JWT_AUDIENCE,
  issuer: process.env.JWT_ISSUER,
});

@McpApp({
  module: AppModule,
  server: {
    name: 'shopping-mcp-server',
    version: '1.0.0',
  },
  // NitroStack 1.0.15 does not pass this setting to the server logger;
  // keep its supported default explicit rather than exposing a misleading
  // application-level log setting.
  logging: {
    level: 'info',
  },
  // Keep transport selection explicit. Runtime defaults are also applied to
  // process.env because NitroStack reads these values in server.start().
  transport: {
    type: runtimeDefaults.transportType,
    http: {
      port: runtimeDefaults.port,
      host: runtimeDefaults.host,
      basePath: '/mcp',
    },
  },
})
@Module({
  name: 'app',
  description: 'Shopping MCP server with eBay catalog, carts, checkout, orders, and widgets',
  imports: [
    ConfigModule.forRoot({
      defaults: {
        DATABASE_FILE: '.data/shopping-db.json',
        DATABASE_POOL_MAX: '10',
        DATABASE_SSL: 'false',
        DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
        EBAY_MARKETPLACE_ID: 'EBAY_US',
        EBAY_SANDBOX: 'false',
        SHOPPING_TAX_RATE: '0',
        ENABLE_CORS: 'false',
        MCP_TRANSPORT_TYPE: runtimeDefaults.transportType,
        PORT: String(runtimeDefaults.port),
        HOST: runtimeDefaults.host,
      },
      validate: (config) => {
        assertValidEnvironment(config);
        return true;
      },
    }),
    CommonModule,
    DatabaseModule,
    AuthModule,
    ProductsModule,
    CartModule,
    OrdersModule,
    HealthModule,
  ],
  providers: [HttpSecurityConfiguration],
})
export class AppModule {}
