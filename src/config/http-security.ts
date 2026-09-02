import { ConfigService, Injectable, NitroStackServer } from '@nitrostack/core';

interface RequestLike {
  method: string;
  get(name: string): string | undefined;
}

interface ResponseLike {
  setHeader(name: string, value: string): void;
  status(code: number): ResponseLike;
  json(body: unknown): ResponseLike;
  end(): void;
}

type NextFunction = () => void;
type Middleware = (request: RequestLike, response: ResponseLike, next: NextFunction) => void;

interface RouterLayer {
  handle: Middleware;
}

interface ExpressAppLike {
  _router?: {
    stack: RouterLayer[];
  };
}

function readOrigins(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  const origins = new Set<string>();
  for (const valuePart of value.split(',')) {
    const origin = valuePart.trim();
    if (!origin || origin.includes('*')) {
      continue;
    }
    try {
      const parsed = new URL(origin);
      origins.add(parsed.origin);
    } catch {
      // Startup validation rejects malformed origins. Ignore one here as a
      // second line of defense if this provider is used independently.
    }
  }
  return origins;
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== '' && parsed.pathname !== '/') ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function readHostList(value: string | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const part of (value ?? '').split(',')) {
    const host = part.trim().toLowerCase();
    if (host && !host.includes('*')) {
      hosts.add(host);
    }
  }
  return hosts;
}

function isLocalhost(host: string): boolean {
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  const normalized = hostname?.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Applies an exact-origin CORS policy to NitroStack's HTTP transport.
 *
 * NitroStack 1.x exposes only an enableCors boolean and otherwise installs a
 * wildcard middleware. This provider replaces that middleware before the
 * transport registers its routes, keeping the default deny-by-origin policy
 * while still supporting an explicit CORS_ALLOWED_ORIGINS list.
 */
@Injectable({ deps: [ConfigService, NitroStackServer] })
export class HttpSecurityConfiguration {
  constructor(
    private readonly config: ConfigService,
    private readonly server: NitroStackServer,
  ) {}

  onApplicationBootstrap(): void {
    const transport = this.server.getHttpTransport();
    const app = transport?.getApp?.() as ExpressAppLike | undefined;
    if (!app) {
      return;
    }

    const stack = app._router?.stack;
    if (!stack) {
      throw new Error('Unable to configure HTTP origin policy before transport startup');
    }

    const corsEnabled = this.config.get<string>('ENABLE_CORS', 'false').toLowerCase() === 'true';
    const allowedOrigins = readOrigins(this.config.get<string>('CORS_ALLOWED_ORIGINS'));
    const trustedForwardedHosts = readHostList(this.config.get<string>('TRUSTED_FORWARDED_HOSTS'));
    const requireHttps = this.config.get<string>('REQUIRE_HTTPS', 'false')?.toLowerCase() === 'true';
    const policyLayer = stack.find((layer) => {
      const source = Function.prototype.toString.call(layer.handle);
      return source.includes('Access-Control-Allow-Origin') || source.includes('Invalid Origin header');
    });

    if (!policyLayer) {
      // Failing closed is safer than starting with an unknown framework CORS
      // behavior after a NitroStack upgrade.
      throw new Error('Unable to locate NitroStack HTTP origin policy middleware');
    }

    policyLayer.handle = this.createRequestPolicy({
      corsEnabled,
      allowedOrigins,
      trustedForwardedHosts,
      requireHttps,
    });
  }

  /**
   * Validates proxy-supplied headers and then applies the origin policy.
   *
   * Behind a reverse proxy, `X-Forwarded-Host` decides which host the
   * application believes it is serving, so an unvalidated value is a
   * host-header attack. It is only accepted when it appears in an explicit
   * allowlist. `X-Forwarded-Proto` is checked separately so a TLS-terminating
   * proxy can be required to forward only HTTPS traffic.
   */
  private createRequestPolicy(options: {
    corsEnabled: boolean;
    allowedOrigins: Set<string>;
    trustedForwardedHosts: Set<string>;
    requireHttps: boolean;
  }): Middleware {
    const { corsEnabled, allowedOrigins, trustedForwardedHosts, requireHttps } = options;
    return (request, response, next) => {
      const forwardedHost = request.get('X-Forwarded-Host')?.split(',')[0]?.trim().toLowerCase();
      if (forwardedHost && trustedForwardedHosts.size > 0 && !trustedForwardedHosts.has(forwardedHost)) {
        response.status(403).json({ error: 'Forwarded host is not allowed' });
        return;
      }
      if (forwardedHost && trustedForwardedHosts.size === 0) {
        // No allowlist is configured, so the header cannot be trusted at all.
        response.status(403).json({ error: 'Forwarded host is not allowed' });
        return;
      }

      if (requireHttps) {
        const forwardedProto = request.get('X-Forwarded-Proto')?.split(',')[0]?.trim().toLowerCase();
        if (forwardedProto !== undefined && forwardedProto !== 'https') {
          response.status(403).json({ error: 'HTTPS is required' });
          return;
        }
      }

      const origin = request.get('Origin');
      if (!origin) {
        next();
        return;
      }

      const normalizedOrigin = normalizeOrigin(origin);
      if (!normalizedOrigin) {
        response.status(403).json({ error: 'Invalid Origin header' });
        return;
      }

      if (!corsEnabled) {
        const requestHost = request.get('Host');
        const originHost = new URL(normalizedOrigin).host;

        // Preserve NitroStack's same-origin/DNS-rebinding protection when CORS
        // is disabled. Cross-origin browser requests require explicit opt-in.
        if (requestHost && originHost !== requestHost && !isLocalhost(originHost)) {
          response.status(403).json({ error: 'Origin is not allowed' });
          return;
        }
        next();
        return;
      }

      if (!allowedOrigins.has(normalizedOrigin)) {
        response.status(403).json({ error: 'Origin is not allowed' });
        return;
      }

      response.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
      );
      response.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

      if (request.method === 'OPTIONS') {
        response.status(204).end();
        return;
      }

      next();
    };
  }
}
