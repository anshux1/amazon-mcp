import {
  ConfigModule,
  JWTModule,
  McpApp,
  Module,
} from '@nitrostack/core';
import { CommonModule } from './common/common.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DatabaseHealthCheck } from './health/database.health.js';
import { EbayHealthCheck } from './health/ebay.health.js';
import { SystemHealthCheck } from './health/system.health.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { ProductsModule } from './modules/products/products.module.js';

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
  logging: {
    level: 'info',
  },
})
@Module({
  name: 'app',
  description: 'Shopping MCP server with eBay catalog, carts, checkout, orders, and widgets',
  imports: [
    ConfigModule.forRoot({
      defaults: {
        DATABASE_FILE: '.data/shopping-db.json',
        EBAY_MARKETPLACE_ID: 'EBAY_US',
        EBAY_SANDBOX: 'false',
        SHOPPING_TAX_RATE: '0',
      },
    }),
    CommonModule,
    DatabaseModule,
    AuthModule,
    ProductsModule,
    CartModule,
    OrdersModule,
  ],
  providers: [
    SystemHealthCheck,
    DatabaseHealthCheck,
    EbayHealthCheck,
  ],
})
export class AppModule {}
