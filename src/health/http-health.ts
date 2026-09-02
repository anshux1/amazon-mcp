import { ConfigService, Injectable, NitroStackServer } from '@nitrostack/core';
import { DatabaseService } from '../database/database.service.js';
import { EbayService } from '../modules/products/ebay.service.js';

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

interface ExpressAppLike {
  get(path: string, handler: (request: unknown, response: ResponseLike) => void): void;
}

/**
 * Load-balancer health endpoints for the HTTP transport.
 *
 * `health://checks` stays the MCP-facing view. Kubernetes and most load
 * balancers cannot speak MCP, so liveness and readiness are also exposed as
 * plain HTTP.
 *
 * Liveness and readiness are deliberately separate: liveness answers "is this
 * process wedged", so it never consults a dependency and a temporary eBay or
 * database outage cannot cause a restart loop. Readiness answers "should this
 * replica receive traffic", so it fails when persistence is unusable, while a
 * degraded eBay dependency only annotates the response.
 */
@Injectable({ deps: [ConfigService, NitroStackServer, DatabaseService, EbayService] })
export class HttpHealthEndpoints {
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: ConfigService,
    private readonly server: NitroStackServer,
    private readonly database: DatabaseService,
    private readonly ebay: EbayService,
  ) {}

  onApplicationBootstrap(): void {
    const transport = this.server.getHttpTransport();
    const app = transport?.getApp?.() as ExpressAppLike | undefined;
    if (!app) {
      return;
    }

    app.get('/healthz', (_request, response) => {
      response.status(200).json({
        status: 'alive',
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      });
    });

    app.get('/readyz', (_request, response) => {
      void this.readiness().then((result) => {
        response.status(result.ready ? 200 : 503).json(result);
      });
    });
  }

  async readiness(): Promise<{
    ready: boolean;
    checks: { database: string; ebay: string };
    details?: Record<string, unknown>;
  }> {
    const databaseReady = await this.database.ping();
    const ebayStatus = this.ebay.isConfigured() ? 'configured' : 'demo';
    const exposeDetails = this.config.get<string>('HEALTH_DETAILS', 'false')?.toLowerCase() === 'true';

    return {
      ready: databaseReady,
      checks: {
        database: databaseReady ? 'up' : 'down',
        ebay: ebayStatus,
      },
      // Storage mode and migration state are useful during a rollout but they
      // describe the deployment, so they stay behind an explicit opt-in.
      ...(exposeDetails
        ? {
            details: {
              storageMode: this.database.getMode(),
              supportsReplicas: this.database.supportsReplicas(),
              appliedMigrations: this.database.getAppliedMigrations(),
              initializationError: this.database.getInitializationError(),
            },
          }
        : {}),
    };
  }
}
