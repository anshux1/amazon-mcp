import {
  ConfigService,
  DIContainer,
  Injectable,
  type ExecutionContext,
  type Guard,
  verifyJWT,
} from '@nitrostack/core';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWSAlgorithm,
  type JWTVerifyOptions,
  type RemoteJWKSet,
} from 'jose';
import { UnauthorizedError } from '../../common/errors.js';

/** Algorithms that may be configured for the Better Auth bridge. */
export const JWT_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];
export const DEFAULT_JWT_ALGORITHM: JwtAlgorithm = 'HS256';
export const DEFAULT_JWT_MAX_LIFETIME_SECONDS = 3600;

const HMAC_ALGORITHMS: ReadonlySet<string> = new Set(['HS256', 'HS384', 'HS512']);
const jwksResolvers = new Map<string, RemoteJWKSet>();
const jwksForcedReloadAt = new Map<string, number>();
const JWKS_FORCED_RELOAD_MIN_INTERVAL_MS = 1000;

export type BetterAuthJWTPayload = {
  sub?: unknown;
  scopes?: unknown;
  scope?: unknown;
  client_id?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  [key: string]: unknown;
};

function readConfigString(config: ConfigService, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = config.get<unknown>(key);
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readMetadataValue(metadata: Record<string, unknown> | undefined, key: string): unknown {
  if (!metadata) {
    return undefined;
  }

  if (metadata[key] !== undefined) {
    return metadata[key];
  }

  // Some direct callers pass the complete MCP params object to a guard. The
  // NitroStack MCP handler flattens this block before creating its context,
  // but accepting it here makes the contract explicit and unit-testable.
  const nestedMeta = metadata._meta;
  if (nestedMeta && typeof nestedMeta === 'object' && !Array.isArray(nestedMeta)) {
    return (nestedMeta as Record<string, unknown>)[key];
  }
  return undefined;
}

/** Extracts the standard Bearer token from MCP metadata or an HTTP bridge. */
export function extractToken(context: ExecutionContext): string | null {
  const metadata = context.metadata as Record<string, unknown> | undefined;
  const authorization =
    readMetadataValue(metadata, 'authorization') ??
    readMetadataValue(metadata, 'Authorization');

  if (typeof authorization === 'string') {
    const match = authorization.trim().match(/^Bearer\s+([^\s]+)$/i);
    if (match?.[1]) {
      return match[1];
    }
    return null;
  }

  // These aliases are retained for older NitroStack clients. New clients
  // should always use Authorization: Bearer ... or _meta.authorization.
  for (const key of ['token', '_oauth']) {
    const token = readMetadataValue(metadata, key);
    if (typeof token === 'string' && token.trim().length > 0) {
      return token.trim();
    }
  }
  return null;
}

function appendScopes(target: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    for (const scope of value.split(/\s+/)) {
      const normalized = scope.trim();
      if (normalized) {
        target.add(normalized);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) {
        target.add(entry.trim());
      }
    }
  }
}

/** Supports Better Auth's array claim and OAuth's space-separated claim. */
export function extractScopes(payload: BetterAuthJWTPayload): string[] {
  const scopes = new Set<string>();
  appendScopes(scopes, payload.scopes);
  appendScopes(scopes, payload.scope);
  return [...scopes];
}

export function getJwtAlgorithm(config: ConfigService): JwtAlgorithm {
  const configured = readConfigString(config, 'JWT_ALGORITHM') ?? DEFAULT_JWT_ALGORITHM;
  if (!(JWT_ALGORITHMS as readonly string[]).includes(configured)) {
    throw new UnauthorizedError(`JWT algorithm '${configured}' is not allowed`);
  }
  return configured as JwtAlgorithm;
}

export function isHmacJwtAlgorithm(algorithm: JwtAlgorithm): boolean {
  return HMAC_ALGORITHMS.has(algorithm);
}

function isPlaceholderSecret(secret: string): boolean {
  return /^replace[-_ ]with/i.test(secret) ||
    /^change[-_ ]?me/i.test(secret) ||
    /^your[-_ ]?(secret|jwt)/i.test(secret) ||
    /^default[-_ ]?secret$/i.test(secret) ||
    /^test[-_ ]?secret$/i.test(secret) ||
    /^secret$/i.test(secret) ||
    /^(.)\1+$/.test(secret);
}

/**
 * Returns the current signing secret followed by the previous secret, when
 * configured. Keeping the old secret during the token lifetime makes rotation
 * a two-deploy operation instead of logging out every active user.
 */
export function getJwtVerificationSecrets(config: ConfigService): string[] {
  const current = readConfigString(
    config,
    'JWT_SECRET',
    'BETTER_AUTH_JWT_SECRET',
    'BETTER_AUTH_SECRET',
  );
  if (!current || isPlaceholderSecret(current)) {
    throw new UnauthorizedError('JWT authentication is not configured');
  }

  const previous = readConfigString(
    config,
    'JWT_SECRET_PREVIOUS',
    'BETTER_AUTH_JWT_SECRET_PREVIOUS',
  );
  return previous && previous !== current && !isPlaceholderSecret(previous)
    ? [current, previous]
    : [current];
}

function getMaximumTokenLifetime(config: ConfigService): number {
  const configured = readConfigString(config, 'JWT_MAX_TOKEN_LIFETIME_SECONDS');
  if (!configured) {
    return DEFAULT_JWT_MAX_LIFETIME_SECONDS;
  }

  const lifetime = Number(configured);
  if (!Number.isSafeInteger(lifetime) || lifetime < 1) {
    throw new UnauthorizedError('JWT expiration policy is not configured correctly');
  }
  return lifetime;
}

function getJwksCacheMaxAge(config: ConfigService): number {
  const configured = readConfigString(config, 'JWT_JWKS_CACHE_MAX_AGE_SECONDS');
  if (!configured) {
    return 600;
  }

  const seconds = Number(configured);
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new UnauthorizedError('JWT JWKS cache policy is not configured correctly');
  }
  return seconds;
}

export function getJwksResolver(config: ConfigService): RemoteJWKSet {
  const jwksUri = readConfigString(config, 'JWT_JWKS_URI', 'BETTER_AUTH_JWKS_URI');
  if (!jwksUri) {
    throw new UnauthorizedError('JWT JWKS URI is not configured');
  }

  let parsedUri: URL;
  try {
    parsedUri = new URL(jwksUri);
  } catch {
    throw new UnauthorizedError('JWT JWKS URI is invalid');
  }

  const existing = jwksResolvers.get(parsedUri.href);
  if (existing) {
    return existing;
  }

  // createRemoteJWKSet caches successful key material in memory and refreshes
  // when a token presents an unknown kid. An unavailable endpoint therefore
  // fails closed for new keys while already cached keys can continue to work.
  const resolver = createRemoteJWKSet(parsedUri, {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
    cacheMaxAge: getJwksCacheMaxAge(config) * 1000,
  });
  jwksResolvers.set(parsedUri.href, resolver);
  return resolver;
}

/** Clears the process-local JWKS cache between key-rollover tests. */
export function clearJwksCache(): void {
  jwksResolvers.clear();
  jwksForcedReloadAt.clear();
}

function hasValidExpiration(payload: BetterAuthJWTPayload, maxLifetime: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= now) {
    return false;
  }

  // Better Auth includes iat. If present, enforce the server's maximum token
  // lifetime as defense in depth against an accidentally overlong issuer
  // configuration. Do not require iat so tokens from compatible JWT bridges
  // that only emit the required exp claim remain interoperable.
  if (payload.iat !== undefined) {
    if (
      typeof payload.iat !== 'number' ||
      !Number.isSafeInteger(payload.iat) ||
      payload.iat > now + 30 ||
      payload.exp - payload.iat > maxLifetime
    ) {
      return false;
    }
  }
  return true;
}

function verifyWithConfiguredSecrets(
  token: string,
  secrets: string[],
  algorithm: JwtAlgorithm,
  audience: string,
  issuer: string,
): BetterAuthJWTPayload | null {
  for (const secret of secrets) {
    const payload = verifyJWT(token, {
      secret,
      algorithm: algorithm as 'HS256' | 'HS384' | 'HS512',
      audience,
      issuer,
    }) as BetterAuthJWTPayload | null;
    if (payload) {
      return payload;
    }
  }
  return null;
}

async function verifyWithJwks(
  token: string,
  config: ConfigService,
  algorithm: JwtAlgorithm,
  audience: string,
  issuer: string,
): Promise<BetterAuthJWTPayload | null> {
  const resolver = getJwksResolver(config);
  const verifyOptions: JWTVerifyOptions = {
    algorithms: [algorithm as JWSAlgorithm],
    audience,
    issuer,
    clockTolerance: 30,
  };

  try {
    const result = await jwtVerify(token, resolver, verifyOptions);
    return result.payload as BetterAuthJWTPayload;
  } catch {
    // jose normally refreshes a remote set when a kid is unknown, subject to
    // its cooldown. Trigger one bounded rollover refresh for a genuinely new
    // kid so a Better Auth rotation becomes available without waiting for the
    // cache cooldown. The one-second process-local bound prevents invalid
    // random-kid tokens from turning into an unbounded JWKS fetch loop.
    let protectedHeader: { alg?: unknown; kid?: unknown };
    try {
      protectedHeader = decodeProtectedHeader(token);
    } catch {
      return null;
    }

    const cachedKeys = resolver.jwks()?.keys ?? [];
    const hasUnknownKid = typeof protectedHeader.kid === 'string' &&
      !cachedKeys.some((key) => key.kid === protectedHeader.kid && (key.alg === undefined || key.alg === algorithm));
    const jwksUri = readConfigString(config, 'JWT_JWKS_URI', 'BETTER_AUTH_JWKS_URI');
    const lastReload = jwksUri ? jwksForcedReloadAt.get(jwksUri) ?? 0 : 0;
    if (!hasUnknownKid || !jwksUri || Date.now() - lastReload < JWKS_FORCED_RELOAD_MIN_INTERVAL_MS) {
      return null;
    }

    jwksForcedReloadAt.set(jwksUri, Date.now());
    try {
      await resolver.reload();
      const result = await jwtVerify(token, resolver, verifyOptions);
      return result.payload as BetterAuthJWTPayload;
    } catch {
      // No stale/unsigned fallback: an unavailable endpoint or unknown key is
      // an authentication failure.
      return null;
    }
  }
}

/** Verifies a Better Auth token without exposing secret or library errors. */
export async function verifyBetterAuthToken(
  token: string,
  config: ConfigService,
): Promise<BetterAuthJWTPayload> {
  const audience = readConfigString(config, 'JWT_AUDIENCE');
  const issuer = readConfigString(config, 'JWT_ISSUER');
  if (!audience || !issuer) {
    throw new UnauthorizedError('JWT issuer and audience are not configured');
  }

  const algorithm = getJwtAlgorithm(config);
  const payload = isHmacJwtAlgorithm(algorithm)
    ? verifyWithConfiguredSecrets(token, getJwtVerificationSecrets(config), algorithm, audience, issuer)
    : await verifyWithJwks(token, config, algorithm, audience, issuer);

  if (!payload || typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
    throw new UnauthorizedError('The supplied JWT is invalid or has no subject');
  }
  if (!hasValidExpiration(payload, getMaximumTokenLifetime(config))) {
    throw new UnauthorizedError('The supplied JWT is expired or exceeds the token lifetime policy');
  }
  return payload;
}

/** Validates a JWT minted by Better Auth and attaches its subject to ctx.auth. */
@Injectable({ deps: [ConfigService] })
export class JWTGuard implements Guard {
  private readonly config: ConfigService;

  constructor(config?: unknown) {
    this.config = config instanceof ConfigService
      ? config
      : DIContainer.getInstance().has(ConfigService)
        ? DIContainer.getInstance().resolve(ConfigService)
        : new ConfigService();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const token = extractToken(context);
    if (!token) {
      throw new UnauthorizedError('A Bearer token is required for this tool');
    }

    const payload = await verifyBetterAuthToken(token, this.config);
    context.auth = {
      subject: payload.sub as string,
      scopes: extractScopes(payload),
      clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined,
      exp: payload.exp as number,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      iss: typeof payload.iss === 'string' ? payload.iss : undefined,
      tokenPayload: payload,
    };
    return true;
  }
}
