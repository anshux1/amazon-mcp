export const TRANSPORT_TYPES = ['stdio', 'http', 'dual'] as const;
export type TransportType = (typeof TRANSPORT_TYPES)[number];

const BOOLEAN_VALUES = new Set(['true', 'false']);
const JWT_ALGORITHMS = new Set(['HS256', 'HS384', 'HS512']);
const PLACEHOLDER_SECRET_PATTERNS = [
  /^replace[-_ ]with/i,
  /^change[-_ ]?me/i,
  /^your[-_ ]?(secret|jwt)/i,
  /^default[-_ ]?secret/i,
  /^test[-_ ]?secret$/i,
  /^secret$/i,
];

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
  if (algorithm !== undefined && !JWT_ALGORITHMS.has(algorithm)) {
    errors.push('JWT_ALGORITHM must be HS256, HS384, or HS512');
  }

  if (productionLike) {
    if (!jwtSecret || Buffer.byteLength(jwtSecret, 'utf8') < 32 || isPlaceholderSecret(jwtSecret)) {
      errors.push('JWT_SECRET must be a non-placeholder secret with at least 32 bytes');
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
  return {
    transportType: TRANSPORT_TYPES.includes(transportType as TransportType)
      ? transportType as TransportType
      : 'stdio',
    port,
    host: env.HOST,
    enableCors: env.ENABLE_CORS.toLowerCase() === 'true',
  };
}
