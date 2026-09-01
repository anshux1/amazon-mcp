import {
  ConfigService,
  DIContainer,
  Injectable,
  type ExecutionContext,
  type Guard,
  verifyJWT,
} from '@nitrostack/core';
import { UnauthorizedError } from '../../common/errors.js';

type BetterAuthJWTPayload = {
  sub?: string;
  scopes?: unknown;
  scope?: unknown;
  client_id?: unknown;
  exp?: number;
  iat?: number;
  iss?: string;
  [key: string]: unknown;
};

function extractToken(context: ExecutionContext): string | null {
  const authorization = context.metadata?.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  const token = context.metadata?.token ?? context.metadata?._oauth;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function extractScopes(payload: BetterAuthJWTPayload): string[] {
  if (Array.isArray(payload.scopes)) {
    return payload.scopes.filter((scope): scope is string => typeof scope === 'string');
  }
  if (typeof payload.scope === 'string') {
    return payload.scope.split(/\s+/).filter(Boolean);
  }
  return [];
}

/** Validates the JWT minted by Better Auth and attaches its subject to ctx.auth. */
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

    const secret =
      this.config.get<string>('JWT_SECRET') ??
      this.config.get<string>('BETTER_AUTH_JWT_SECRET') ??
      this.config.get<string>('BETTER_AUTH_SECRET');
    if (!secret || secret.startsWith('replace-with-')) {
      throw new UnauthorizedError('JWT authentication is not configured');
    }

    const configuredAlgorithm = this.config.get<string>('JWT_ALGORITHM', 'HS256');
    const algorithm = ['HS256', 'HS384', 'HS512'].includes(configuredAlgorithm)
      ? (configuredAlgorithm as 'HS256' | 'HS384' | 'HS512')
      : 'HS256';
    const payload = verifyJWT(token, {
      secret,
      algorithm,
      audience: this.config.get<string>('JWT_AUDIENCE'),
      issuer: this.config.get<string>('JWT_ISSUER'),
    }) as BetterAuthJWTPayload | null;

    if (!payload || typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedError('The supplied JWT is invalid or has no subject');
    }

    context.auth = {
      subject: payload.sub,
      scopes: extractScopes(payload),
      clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined,
      exp: payload.exp,
      iat: payload.iat,
      iss: payload.iss,
      tokenPayload: payload,
    };
    return true;
  }
}
