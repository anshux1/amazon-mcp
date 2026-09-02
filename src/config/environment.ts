export const TRANSPORT_TYPES = ['stdio', 'http', 'dual'] as const;
export type TransportType = (typeof TRANSPORT_TYPES)[number];

const BOOLEAN_VALUES = new Set(['true', 'false']);
export const JWT_ALGORITHMS = [
  'HS256', 'HS384', 'HS512',
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
] as const;
const JWT_ALGORITHM_SET = new Set<string>(JWT_ALGORITHMS);
const HMAC_JWT_ALGORITHMS = new Set(['HS256', 'HS384', 'HS512']);
const JWT_EXPIRATION_PATTERN = /^(?:[1-9]\d*)(?:s|m|h|d)$/i;

function parseJwtDuration(value: string | undefined): number | undefined {
  if (!value || !JWT_EXPIRATION_PATTERN.test(value)) {
    return undefined;
  }
  const match = value.match(/^(\d+)([smhd])$/i);
  if (!match) {
    return undefined;
  }
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
  const seconds = Number(match[1]) * multipliers[match[2].toLowerCase()];
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}
const PLACEHOLDER_SECRET_PATTERNS = [
  /^replace[-_ ]with/i,
  /^change[-_ ]?me/i,
  /^your[-_ ]?(secret|jwt)/i,
  /^default[-_ ]?secret/i,
  /^test[-_ ]?secret$/i,
  /^secret$/i,
];

export const FULFILLMENT_MODES = ['demo', 'external'] as const;
export const QUOTA_FALLBACK_POLICIES = ['reject', 'local'] as const;

export interface OAuthConfiguration {
  resourceUri: string;
  authorizationServers: string[];
  audience?: string;
  issuer?: string;
  jwksUri?: string;
  required: boolean;
}

export interface RuntimeDefaults {
  transportType: TransportType;
  port: number;
  host: string;
  enableCors: boolean;
}

function getString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

function hasValue(config: Record<string, unknown>, key: string): boolean {
  return Boolean(getString(config, key));
}

function isValidBoolean(value: string | undefined): boolean {
  return value === undefined || BOOLEAN_VALUES.has(value.toLowerCase());
}

function isProductionLike(config: Record<string, unknown>): boolean {
  const nodeEnv = getString(config, 'NODE_ENV')?.toLowerCase();
  // NitroStack treats an unset NODE_ENV as development. Keep the validation
  // rules aligned with that behavior while treating every named environment
  // other than development/dev as deployment-like (including staging).
  return nodeEnv !== undefined && nodeEnv !== '' && nodeEnv !== 'development' && nodeEnv !== 'dev';
}

export function isDevelopmentEnvironment(config: Record<string, unknown> = process.env): boolean {
  return !isProductionLike(config);
}

function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER_SECRET_PATTERNS.some((pattern) => pattern.test(value)) || /^(.)\1+$/.test(value);
}

function parseOriginList(value: string | undefined): { valid: boolean; empty: boolean } {
  if (value === undefined || value === '') {
    return { valid: true, empty: true };
  }

  const origins = value.split(',').map((origin) => origin.trim());
  if (origins.some((origin) => origin === '' || origin.includes('*'))) {
    return { valid: false, empty: false };
  }

  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        (parsed.pathname !== '' && parsed.pathname !== '/') ||
        parsed.search ||
        parsed.hash
      ) {
        return { valid: false, empty: false };
      }
    } catch {
      return { valid: false, empty: false };
    }
  }

  return { valid: true, empty: false };
}

function validateInteger(
  config: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  errors: string[],
): void {
  const value = getString(config, key);
  if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value)) {
    errors.push(`${key} must be an integer from ${minimum} to ${maximum}`);
    return;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
}

function parseUrlList(value: string | undefined): { valid: boolean; urls: string[] } {
  const parts = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { valid: false, urls: [] };
  }

  for (const part of parts) {
    try {
      const parsed = new URL(part);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        return { valid: false, urls: [] };
      }
    } catch {
      return { valid: false, urls: [] };
    }
  }
  return { valid: true, urls: parts };
}

export function isOAuthEnabled(config: Record<string, unknown> = process.env): boolean {
  return getString(config, 'OAUTH_ENABLED')?.toLowerCase() === 'true';
}

/**
 * Reads the OAuth 2.1 discovery settings. Only called after validation has
 * confirmed the required values are present and well formed.
 */
export function readOAuthConfiguration(config: Record<string, unknown> = process.env): OAuthConfiguration {
  return {
    resourceUri: getString(config, 'OAUTH_RESOURCE_URI') ?? '',
    authorizationServers: parseUrlList(getString(config, 'OAUTH_AUTHORIZATION_SERVERS')).urls,
    audience: getString(config, 'OAUTH_AUDIENCE') ?? getString(config, 'JWT_AUDIENCE'),
    issuer: getString(config, 'OAUTH_ISSUER') ?? getString(config, 'JWT_ISSUER'),
    jwksUri: getString(config, 'JWT_JWKS_URI') ?? getString(config, 'BETTER_AUTH_JWKS_URI'),
    required: getString(config, 'OAUTH_REQUIRED')?.toLowerCase() === 'true',
  };
}

/**
 * Returns safe, value-free configuration errors. Never include the contents of
 * environment variables here: this list is suitable for a startup exception.
 */
export function getConfigurationErrors(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const productionLike = isProductionLike(config);
  const transport = getString(config, 'MCP_TRANSPORT_TYPE');
  const host = getString(config, 'HOST');
  const corsEnabled = getString(config, 'ENABLE_CORS');
  const corsOrigins = getString(config, 'CORS_ALLOWED_ORIGINS');
  const ebayMock = getString(config, 'EBAY_MOCK')?.toLowerCase();
  const databaseUrl = getString(config, 'DATABASE_URL');
  const jwtSecret = getString(config, 'JWT_SECRET');
  const jwtPreviousSecret = getString(config, 'JWT_SECRET_PREVIOUS');
  const jwtAudience = getString(config, 'JWT_AUDIENCE');
  const jwtIssuer = getString(config, 'JWT_ISSUER');
  const jwtExpiresIn = getString(config, 'JWT_EXPIRES_IN');
  const jwtJwksUri = getString(config, 'JWT_JWKS_URI') ?? getString(config, 'BETTER_AUTH_JWKS_URI');

  if (!transport || !TRANSPORT_TYPES.includes(transport as TransportType)) {
    errors.push('MCP_TRANSPORT_TYPE must be one of stdio, http, or dual');
  }

  if (transport !== 'stdio' && !host) {
    errors.push('HOST is required for HTTP or dual transport');
  }

  if (!isValidBoolean(corsEnabled)) {
    errors.push('ENABLE_CORS must be true or false');
  }

  const parsedOrigins = parseOriginList(corsOrigins);
  if (!parsedOrigins.valid) {
    errors.push('CORS_ALLOWED_ORIGINS must be a comma-separated list of absolute HTTP(S) origins; wildcard origins are not allowed');
  }
  if (corsEnabled?.toLowerCase() === 'true' && parsedOrigins.empty) {
    errors.push('CORS_ALLOWED_ORIGINS is required when ENABLE_CORS=true');
  }

  validateInteger(config, 'PORT', productionLike && transport !== 'stdio' ? 1 : 0, 65535, errors);
  validateInteger(config, 'DATABASE_POOL_MAX', 1, 100, errors);

  const taxRate = getString(config, 'SHOPPING_TAX_RATE');
  const parsedTaxRate = taxRate === undefined || taxRate === '' ? Number.NaN : Number(taxRate);
  if (!Number.isFinite(parsedTaxRate) || parsedTaxRate < 0 || parsedTaxRate > 1) {
    errors.push('SHOPPING_TAX_RATE must be a decimal number from 0 to 1');
  }

  for (const key of ['DATABASE_SSL', 'DATABASE_SSL_REJECT_UNAUTHORIZED', 'EBAY_SANDBOX']) {
    if (!isValidBoolean(getString(config, key))) {
      errors.push(`${key} must be true or false`);
    }
  }

  const algorithm = getString(config, 'JWT_ALGORITHM');
  if (algorithm !== undefined && !JWT_ALGORITHM_SET.has(algorithm)) {
    errors.push('JWT_ALGORITHM is not supported; use an explicitly allowed HMAC, RSA, PSS, EC, or EdDSA algorithm');
  }
  const usesHmac = !algorithm || HMAC_JWT_ALGORITHMS.has(algorithm);
  if (!usesHmac && !jwtJwksUri) {
    errors.push('JWT_JWKS_URI is required for asymmetric JWT algorithms');
  }
  if (jwtJwksUri) {
    try {
      const parsedJwksUri = new URL(jwtJwksUri);
      if (!['http:', 'https:'].includes(parsedJwksUri.protocol) || parsedJwksUri.username || parsedJwksUri.password || parsedJwksUri.hash) {
        errors.push('JWT_JWKS_URI must be an absolute HTTP(S) URL without credentials or a fragment');
      }
      if (productionLike && parsedJwksUri.protocol !== 'https:') {
        errors.push('JWT_JWKS_URI must use HTTPS outside development');
      }
    } catch {
      errors.push('JWT_JWKS_URI must be an absolute HTTP(S) URL without credentials or a fragment');
    }
  }
  if (!usesHmac && jwtPreviousSecret) {
    errors.push('JWT_SECRET_PREVIOUS is only supported for HMAC JWT rotation');
  }
  if (!jwtAudience) {
    errors.push('JWT_AUDIENCE is required for the Better Auth JWT bridge');
  }
  if (!jwtIssuer) {
    errors.push('JWT_ISSUER is required for the Better Auth JWT bridge');
  }
  if (!jwtExpiresIn || !JWT_EXPIRATION_PATTERN.test(jwtExpiresIn)) {
    errors.push('JWT_EXPIRES_IN must be a positive duration such as 15m, 1h, or 1d');
  }
  validateInteger(config, 'JWT_MAX_TOKEN_LIFETIME_SECONDS', 1, 31_536_000, errors);
  const configuredMaxLifetime = getString(config, 'JWT_MAX_TOKEN_LIFETIME_SECONDS');
  const parsedIssuerLifetime = parseJwtDuration(jwtExpiresIn);
  if (
    configuredMaxLifetime &&
    parsedIssuerLifetime !== undefined &&
    Number(configuredMaxLifetime) < parsedIssuerLifetime
  ) {
    errors.push('JWT_MAX_TOKEN_LIFETIME_SECONDS must be at least as large as JWT_EXPIRES_IN');
  }
  validateInteger(config, 'JWT_JWKS_CACHE_MAX_AGE_SECONDS', 1, 86_400, errors);

  if (jwtPreviousSecret && jwtPreviousSecret === jwtSecret) {
    errors.push('JWT_SECRET_PREVIOUS must differ from JWT_SECRET during rotation');
  }

  if (productionLike) {
    if (usesHmac && (!jwtSecret || Buffer.byteLength(jwtSecret, 'utf8') < 32 || isPlaceholderSecret(jwtSecret))) {
      errors.push('JWT_SECRET must be a non-placeholder secret with at least 32 bytes for HMAC JWTs');
    }
    if (jwtPreviousSecret && (Buffer.byteLength(jwtPreviousSecret, 'utf8') < 32 || isPlaceholderSecret(jwtPreviousSecret))) {
      errors.push('JWT_SECRET_PREVIOUS must be a non-placeholder secret with at least 32 bytes');
    }

    if (!databaseUrl) {
      errors.push('DATABASE_URL is required outside development; DATABASE_FILE is only for local/demo use');
    } else if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
      errors.push('DATABASE_URL must use a postgres:// or postgresql:// connection string');
    }

    const hasEbayAppId = hasValue(config, 'EBAY_APP_ID');
    const hasEbayCertId = hasValue(config, 'EBAY_CERT_ID');
    if (ebayMock === 'false' && (!hasEbayAppId || !hasEbayCertId)) {
      errors.push('EBAY_APP_ID and EBAY_CERT_ID are required when EBAY_MOCK=false');
    } else if (ebayMock !== 'true' && (!hasEbayAppId || !hasEbayCertId)) {
      errors.push('Set EBAY_MOCK=true to explicitly enable the demo catalog, or provide EBAY_APP_ID and EBAY_CERT_ID');
    }
  }

  if (ebayMock !== undefined && !BOOLEAN_VALUES.has(ebayMock)) {
    errors.push('EBAY_MOCK must be true or false');
  }

  for (const key of ['REQUIRE_HTTPS', 'HEALTH_DETAILS', 'OAUTH_ENABLED', 'OAUTH_REQUIRED']) {
    if (!isValidBoolean(getString(config, key)?.toLowerCase())) {
      errors.push(`${key} must be true or false`);
    }
  }

  validateInteger(config, 'DATABASE_CONNECTION_TIMEOUT_MS', 1000, 120_000, errors);
  validateInteger(config, 'DATABASE_STATEMENT_TIMEOUT_MS', 1000, 300_000, errors);
  validateInteger(config, 'EBAY_MAX_RETRIES', 0, 5, errors);
  validateInteger(config, 'EBAY_RETRY_BASE_MS', 0, 10_000, errors);
  validateInteger(config, 'EBAY_CATEGORY_MAX_DEPTH', 1, 10, errors);
  validateInteger(config, 'EBAY_CATEGORY_MAX_NODES', 10, 50_000, errors);
  validateInteger(config, 'SHOPPING_QUOTE_TTL_SECONDS', 30, 86_400, errors);
  validateInteger(config, 'SHOPPING_FEATURED_LIMIT', 1, 50, errors);

  const quotaFallback = getString(config, 'EBAY_QUOTA_FALLBACK')?.toLowerCase();
  if (quotaFallback !== undefined && !QUOTA_FALLBACK_POLICIES.includes(quotaFallback as 'reject' | 'local')) {
    errors.push('EBAY_QUOTA_FALLBACK must be reject or local');
  }

  const fulfillment = getString(config, 'SHOPPING_FULFILLMENT_MODE')?.toLowerCase();
  if (fulfillment !== undefined && !FULFILLMENT_MODES.includes(fulfillment as 'demo' | 'external')) {
    errors.push('SHOPPING_FULFILLMENT_MODE must be demo or external');
  } else if (fulfillment === 'external') {
    // There is no payment, reservation, or fulfilment integration in this
    // server. Refusing to start is safer than accepting orders that look real.
    errors.push('SHOPPING_FULFILLMENT_MODE=external is not implemented; this server only records demo orders');
  }

  if (productionLike) {
    if (!getString(config, 'SHOPPING_FULFILLMENT_MODE')) {
      errors.push('SHOPPING_FULFILLMENT_MODE must be set explicitly outside development; only demo is implemented');
    }
  }

  if (isOAuthEnabled(config)) {
    const resourceUri = getString(config, 'OAUTH_RESOURCE_URI');
    if (!resourceUri || !parseUrlList(resourceUri).valid) {
      errors.push('OAUTH_RESOURCE_URI must be an absolute HTTP(S) URL when OAUTH_ENABLED=true');
    }
    if (!parseUrlList(getString(config, 'OAUTH_AUTHORIZATION_SERVERS')).valid) {
      errors.push('OAUTH_AUTHORIZATION_SERVERS must be a comma-separated list of absolute HTTP(S) URLs when OAUTH_ENABLED=true');
    }
    if (transport === 'stdio') {
      errors.push('OAUTH_ENABLED=true requires the http or dual transport for discovery endpoints');
    }
  }

  return errors;
}

/** Boolean validator suitable for ConfigModule.forRoot({ validate }). */
export function validateEnvironment(config: Record<string, unknown>): boolean {
  return getConfigurationErrors(config).length === 0;
}

/** Throws a safe startup error containing field names but never secret values. */
export function assertValidEnvironment(config: Record<string, unknown>): void {
  const errors = getConfigurationErrors(config);
  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration: ${errors.join('; ')}`);
  }
}

/**
 * Applies defaults that NitroStack itself reads directly from process.env.
 * ConfigModule defaults alone cannot configure transport because the framework
 * reads MCP_TRANSPORT_TYPE/PORT/HOST when server.start() runs.
 */
export function applyRuntimeDefaults(env: NodeJS.ProcessEnv = process.env): RuntimeDefaults {
  const productionLike = isProductionLike(env as Record<string, unknown>);

  // NitroStack reads these values directly from process.env at start time;
  // normalize surrounding whitespace before the framework sees them.
  for (const key of ['MCP_TRANSPORT_TYPE', 'PORT', 'HOST'] as const) {
    if (env[key] !== undefined) {
      env[key] = env[key]?.trim();
    }
  }
  if (env.ENABLE_CORS !== undefined) {
    env.ENABLE_CORS = env.ENABLE_CORS.trim().toLowerCase();
  }

  const transportType = env.MCP_TRANSPORT_TYPE === undefined
    ? productionLike ? 'http' : 'stdio'
    : env.MCP_TRANSPORT_TYPE;
  const portValue = env.PORT === undefined ? '3000' : env.PORT;
  const port = Number(portValue);
  if (env.MCP_TRANSPORT_TYPE === undefined) {
    env.MCP_TRANSPORT_TYPE = transportType;
  }
  if (env.PORT === undefined) {
    env.PORT = '3000';
  }
  if (env.HOST === undefined) {
    env.HOST = productionLike ? '0.0.0.0' : 'localhost';
  }
  if (env.ENABLE_CORS === undefined) {
    // CORS is opt-in and is only enabled with an explicit origin allowlist.
    env.ENABLE_CORS = 'false';
  }
  if (env.DATABASE_POOL_MAX === undefined) {
    env.DATABASE_POOL_MAX = '10';
  }
  if (env.JWT_ALGORITHM === undefined) {
    env.JWT_ALGORITHM = 'HS256';
  }
  if (env.JWT_AUDIENCE === undefined) {
    env.JWT_AUDIENCE = 'amazon-mcp';
  }
  if (env.JWT_ISSUER === undefined) {
    env.JWT_ISSUER = 'better-auth';
  }
  if (env.JWT_EXPIRES_IN === undefined) {
    env.JWT_EXPIRES_IN = '1h';
  }
  if (env.JWT_MAX_TOKEN_LIFETIME_SECONDS === undefined) {
    env.JWT_MAX_TOKEN_LIFETIME_SECONDS = String(parseJwtDuration(env.JWT_EXPIRES_IN?.trim()) ?? 3600);
  }
  if (env.JWT_JWKS_CACHE_MAX_AGE_SECONDS === undefined) {
    env.JWT_JWKS_CACHE_MAX_AGE_SECONDS = '600';
  }
  const runtimeDefaultValues: Record<string, string> = {
    DATABASE_CONNECTION_TIMEOUT_MS: '10000',
    DATABASE_STATEMENT_TIMEOUT_MS: '15000',
    EBAY_MAX_RETRIES: '2',
    EBAY_RETRY_BASE_MS: '250',
    EBAY_CATEGORY_MAX_DEPTH: '4',
    EBAY_CATEGORY_MAX_NODES: '2000',
    EBAY_QUOTA_FALLBACK: 'reject',
    SHOPPING_QUOTE_TTL_SECONDS: '600',
    SHOPPING_FEATURED_LIMIT: '10',
    REQUIRE_HTTPS: 'false',
    HEALTH_DETAILS: 'false',
    OAUTH_ENABLED: 'false',
  };
  for (const [key, value] of Object.entries(runtimeDefaultValues)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
  if (env.SHOPPING_FULFILLMENT_MODE === undefined && !productionLike) {
    env.SHOPPING_FULFILLMENT_MODE = 'demo';
  }
  return {
    transportType: TRANSPORT_TYPES.includes(transportType as TransportType)
      ? transportType as TransportType
      : 'stdio',
    port,
    host: env.HOST,
    enableCors: env.ENABLE_CORS.toLowerCase() === 'true',
  };
}
