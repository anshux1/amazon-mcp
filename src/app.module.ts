import 'dotenv/config';
import {
  ConfigModule,
  JWTModule,
  McpApp,
  Module,
  OAuthModule,
  type ModuleImport,
} from '@nitrostack/core';
import { CommonModule } from './common/common.module.js';
import { HttpSecurityConfiguration } from './config/http-security.js';
import {
  applyRuntimeDefaults,
  assertValidEnvironment,
  isOAuthEnabled,
  readOAuthConfiguration,
  type RuntimeDefaults,
} from './config/environment.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { SHOPPING_SCOPES } from './modules/auth/scope.guard.js';

const runtimeDefaults: RuntimeDefaults = applyRuntimeDefaults();

JWTModule.forRoot({
  secretEnvVar: 'JWT_SECRET',
  expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  audience: process.env.JWT_AUDIENCE,
  issuer: process.env.JWT_ISSUER,
});

/**
 * OAuth 2.1 discovery is opt-in.
 *
 * The first-party frontend uses the Better Auth JWT bridge and needs no
 * discovery flow. External MCP clients cannot be configured by hand, so when
 * OAUTH_ENABLED=true the server also advertises protected-resource and
 * authorization-server metadata. Token verification stays with JWTGuard, which
 * is what resolves ctx.auth.subject for every protected tool.
 */
function optionalOAuthModule(): ModuleImport[] {
  if (!isOAuthEnabled(process.env)) {
    return [];
  }

  const oauth = readOAuthConfiguration(process.env);
  return [
    OAuthModule.forRoot({
      resourceUri: oauth.resourceUri,
      authorizationServers: oauth.authorizationServers,
      scopesSupported: [...SHOPPING_SCOPES],
      audience: oauth.audience,
      issuer: oauth.issuer,
      jwksUri: oauth.jwksUri,
      required: oauth.required,
    }) as unknown as ModuleImport,
  ];
}

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
        DATABASE_CONNECTION_TIMEOUT_MS: '10000',
        DATABASE_STATEMENT_TIMEOUT_MS: '15000',
        EBAY_MARKETPLACE_ID: 'EBAY_US',
        EBAY_SANDBOX: 'false',
        EBAY_MAX_RETRIES: '2',
        EBAY_RETRY_BASE_MS: '250',
        EBAY_CATEGORY_MAX_DEPTH: '4',
        EBAY_CATEGORY_MAX_NODES: '2000',
        EBAY_QUOTA_FALLBACK: 'reject',
        SHOPPING_TAX_RATE: '0',
        SHOPPING_QUOTE_TTL_SECONDS: '600',
        SHOPPING_FEATURED_QUERY: 'best selling',
        SHOPPING_FEATURED_LIMIT: '10',
        JWT_ALGORITHM: 'HS256',
        JWT_AUDIENCE: 'amazon-mcp',
        JWT_ISSUER: 'better-auth',
        JWT_EXPIRES_IN: '1h',
        JWT_MAX_TOKEN_LIFETIME_SECONDS: '3600',
        JWT_JWKS_CACHE_MAX_AGE_SECONDS: '600',
        ENABLE_CORS: 'false',
        REQUIRE_HTTPS: 'false',
        HEALTH_DETAILS: 'false',
        OAUTH_ENABLED: 'false',
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
    ObservabilityModule,
    DatabaseModule,
    AuthModule,
    ProductsModule,
    CartModule,
    OrdersModule,
    HealthModule,
    ...optionalOAuthModule(),
  ],
  providers: [HttpSecurityConfiguration],
})
export class AppModule {}
