import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRuntimeDefaults,
  assertValidEnvironment,
  getConfigurationErrors,
  isOAuthEnabled,
  readOAuthConfiguration,
  validateEnvironment,
} from '../../dist/config/environment.js';

const productionBase = {
  NODE_ENV: 'production',
  MCP_TRANSPORT_TYPE: 'http',
  HOST: '0.0.0.0',
  PORT: '3000',
  ENABLE_CORS: 'false',
  DATABASE_POOL_MAX: '10',
  DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
  DATABASE_CONNECTION_TIMEOUT_MS: '10000',
  DATABASE_STATEMENT_TIMEOUT_MS: '15000',
  DATABASE_URL: 'postgresql://user:pw@host/db',
  SHOPPING_TAX_RATE: '0',
  SHOPPING_QUOTE_TTL_SECONDS: '600',
  SHOPPING_FEATURED_LIMIT: '10',
  SHOPPING_FULFILLMENT_MODE: 'demo',
  EBAY_SANDBOX: 'false',
  EBAY_MOCK: 'false',
  EBAY_APP_ID: 'app',
  EBAY_CERT_ID: 'cert',
  EBAY_MAX_RETRIES: '2',
  EBAY_RETRY_BASE_MS: '250',
  EBAY_CATEGORY_MAX_DEPTH: '4',
  EBAY_CATEGORY_MAX_NODES: '2000',
  EBAY_QUOTA_FALLBACK: 'reject',
  JWT_ALGORITHM: 'HS256',
  JWT_SECRET: 'a-production-secret-with-enough-entropy',
  JWT_AUDIENCE: 'amazon-mcp',
  JWT_ISSUER: 'better-auth',
  JWT_EXPIRES_IN: '1h',
  JWT_MAX_TOKEN_LIFETIME_SECONDS: '3600',
  JWT_JWKS_CACHE_MAX_AGE_SECONDS: '600',
  REQUIRE_HTTPS: 'true',
  HEALTH_DETAILS: 'false',
  OAUTH_ENABLED: 'false',
};

const errorsFor = (overrides) => getConfigurationErrors({ ...productionBase, ...overrides });

test('a complete production configuration validates', () => {
  assert.deepEqual(getConfigurationErrors(productionBase), []);
  assert.equal(validateEnvironment(productionBase), true);
  assert.doesNotThrow(() => assertValidEnvironment(productionBase));
});

test('a placeholder or short HMAC secret is refused in production', () => {
  assert.match(errorsFor({ JWT_SECRET: 'short' }).join(';'), /JWT_SECRET/);
  assert.match(errorsFor({ JWT_SECRET: 'replace-with-a-real-secret-value-here' }).join(';'), /JWT_SECRET/);
  assert.match(errorsFor({ JWT_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).join(';'), /JWT_SECRET/);
});

test('rotation requires the previous secret to differ and to be strong', () => {
  assert.match(
    errorsFor({ JWT_SECRET_PREVIOUS: productionBase.JWT_SECRET }).join(';'),
    /JWT_SECRET_PREVIOUS must differ/,
  );
  assert.match(errorsFor({ JWT_SECRET_PREVIOUS: 'tiny' }).join(';'), /at least 32 bytes/);
  assert.deepEqual(errorsFor({ JWT_SECRET_PREVIOUS: 'another-production-secret-with-entropy' }), []);
});

test('an asymmetric algorithm requires an HTTPS JWKS endpoint', () => {
  assert.match(errorsFor({ JWT_ALGORITHM: 'EdDSA' }).join(';'), /JWT_JWKS_URI is required/);
  assert.match(
    errorsFor({ JWT_ALGORITHM: 'EdDSA', JWT_JWKS_URI: 'http://auth.example.com/jwks' }).join(';'),
    /must use HTTPS/,
  );
  assert.deepEqual(errorsFor({ JWT_ALGORITHM: 'EdDSA', JWT_JWKS_URI: 'https://auth.example.com/jwks' }), []);
  assert.match(
    errorsFor({ JWT_ALGORITHM: 'EdDSA', JWT_JWKS_URI: 'https://a/jwks', JWT_SECRET_PREVIOUS: 'another-production-secret-x' }).join(';'),
    /only supported for HMAC/,
  );
  assert.match(errorsFor({ JWT_ALGORITHM: 'none' }).join(';'), /JWT_ALGORITHM is not supported/);
});

test('the token lifetime policy must cover the issuer lifetime', () => {
  assert.match(
    errorsFor({ JWT_EXPIRES_IN: '24h', JWT_MAX_TOKEN_LIFETIME_SECONDS: '3600' }).join(';'),
    /at least as large as JWT_EXPIRES_IN/,
  );
  assert.match(errorsFor({ JWT_EXPIRES_IN: 'soon' }).join(';'), /positive duration/);
});

test('CORS requires an explicit, wildcard-free origin allowlist', () => {
  assert.match(errorsFor({ ENABLE_CORS: 'true' }).join(';'), /CORS_ALLOWED_ORIGINS is required/);
  assert.match(
    errorsFor({ ENABLE_CORS: 'true', CORS_ALLOWED_ORIGINS: 'https://*.example.com' }).join(';'),
    /wildcard origins are not allowed/,
  );
  assert.match(
    errorsFor({ CORS_ALLOWED_ORIGINS: 'https://app.example.com/path' }).join(';'),
    /absolute HTTP\(S\) origins/,
  );
  assert.deepEqual(errorsFor({ ENABLE_CORS: 'true', CORS_ALLOWED_ORIGINS: 'https://app.example.com' }), []);
});

test('production requires Postgres and explicit eBay intent', () => {
  assert.match(errorsFor({ DATABASE_URL: undefined }).join(';'), /DATABASE_URL is required/);
  assert.match(errorsFor({ DATABASE_URL: 'mysql://host/db' }).join(';'), /postgres/);
  assert.match(errorsFor({ EBAY_APP_ID: undefined }).join(';'), /EBAY_APP_ID and EBAY_CERT_ID are required/);
  assert.match(
    errorsFor({ EBAY_MOCK: undefined, EBAY_APP_ID: undefined, EBAY_CERT_ID: undefined }).join(';'),
    /Set EBAY_MOCK=true to explicitly enable the demo catalog/,
  );
});

test('an unimplemented fulfilment mode refuses to start', () => {
  assert.match(
    errorsFor({ SHOPPING_FULFILLMENT_MODE: 'external' }).join(';'),
    /external is not implemented/,
  );
  assert.match(
    errorsFor({ SHOPPING_FULFILLMENT_MODE: 'stripe' }).join(';'),
    /must be demo or external/,
  );
  assert.match(
    errorsFor({ SHOPPING_FULFILLMENT_MODE: undefined }).join(';'),
    /must be set explicitly outside development/,
  );
});

test('numeric and boolean settings are range-checked', () => {
  assert.match(errorsFor({ SHOPPING_TAX_RATE: '1.5' }).join(';'), /SHOPPING_TAX_RATE/);
  assert.match(errorsFor({ SHOPPING_QUOTE_TTL_SECONDS: '5' }).join(';'), /SHOPPING_QUOTE_TTL_SECONDS/);
  assert.match(errorsFor({ EBAY_MAX_RETRIES: '9' }).join(';'), /EBAY_MAX_RETRIES/);
  assert.match(errorsFor({ EBAY_CATEGORY_MAX_DEPTH: '0' }).join(';'), /EBAY_CATEGORY_MAX_DEPTH/);
  assert.match(errorsFor({ DATABASE_POOL_MAX: '0' }).join(';'), /DATABASE_POOL_MAX/);
  assert.match(errorsFor({ REQUIRE_HTTPS: 'yes' }).join(';'), /REQUIRE_HTTPS/);
  assert.match(errorsFor({ EBAY_QUOTA_FALLBACK: 'ignore' }).join(';'), /EBAY_QUOTA_FALLBACK/);
  assert.match(errorsFor({ MCP_TRANSPORT_TYPE: 'grpc' }).join(';'), /MCP_TRANSPORT_TYPE/);
});

test('OAuth discovery requires a resource URI, servers, and an HTTP transport', () => {
  const oauth = { OAUTH_ENABLED: 'true' };
  assert.match(errorsFor(oauth).join(';'), /OAUTH_RESOURCE_URI/);
  assert.match(errorsFor(oauth).join(';'), /OAUTH_AUTHORIZATION_SERVERS/);
  assert.match(
    errorsFor({
      ...oauth,
      MCP_TRANSPORT_TYPE: 'stdio',
      OAUTH_RESOURCE_URI: 'https://mcp.example.com',
      OAUTH_AUTHORIZATION_SERVERS: 'https://auth.example.com',
    }).join(';'),
    /requires the http or dual transport/,
  );
  assert.deepEqual(
    errorsFor({
      ...oauth,
      OAUTH_RESOURCE_URI: 'https://mcp.example.com',
      OAUTH_AUTHORIZATION_SERVERS: 'https://auth.example.com,https://auth2.example.com',
    }),
    [],
  );
});

test('the OAuth configuration reader falls back to the JWT settings', () => {
  const config = {
    OAUTH_ENABLED: 'true',
    OAUTH_RESOURCE_URI: 'https://mcp.example.com',
    OAUTH_AUTHORIZATION_SERVERS: 'https://auth.example.com, https://auth2.example.com',
    JWT_AUDIENCE: 'amazon-mcp',
    JWT_ISSUER: 'better-auth',
    JWT_JWKS_URI: 'https://auth.example.com/jwks',
  };
  assert.equal(isOAuthEnabled(config), true);
  assert.deepEqual(readOAuthConfiguration(config), {
    resourceUri: 'https://mcp.example.com',
    authorizationServers: ['https://auth.example.com', 'https://auth2.example.com'],
    audience: 'amazon-mcp',
    issuer: 'better-auth',
    jwksUri: 'https://auth.example.com/jwks',
    required: false,
  });
  assert.equal(isOAuthEnabled({}), false);
});

test('development defaults choose stdio and a demo-safe configuration', () => {
  const env = {};
  const defaults = applyRuntimeDefaults(env);
  assert.equal(defaults.transportType, 'stdio');
  assert.equal(defaults.host, 'localhost');
  assert.equal(defaults.enableCors, false);
  assert.equal(env.SHOPPING_FULFILLMENT_MODE, 'demo');
  assert.equal(env.EBAY_QUOTA_FALLBACK, 'reject');
  assert.equal(env.JWT_MAX_TOKEN_LIFETIME_SECONDS, '3600');
});

test('production defaults choose HTTP on all interfaces without inventing a mode', () => {
  const env = { NODE_ENV: 'production' };
  const defaults = applyRuntimeDefaults(env);
  assert.equal(defaults.transportType, 'http');
  assert.equal(defaults.host, '0.0.0.0');
  assert.equal(env.SHOPPING_FULFILLMENT_MODE, undefined);
});

test('runtime defaults trim values the framework reads straight from the environment', () => {
  const env = { MCP_TRANSPORT_TYPE: ' dual ', PORT: ' 8080 ', HOST: ' 127.0.0.1 ', ENABLE_CORS: ' TRUE ' };
  const defaults = applyRuntimeDefaults(env);
  assert.equal(defaults.transportType, 'dual');
  assert.equal(defaults.port, 8080);
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.enableCors, true);
});
