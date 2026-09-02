import { ConfigService, Injectable, type RateLimitStorage } from '@nitrostack/core';
import { DatabaseService } from '../../database/database.service.js';
import { MetricsService } from '../../observability/metrics.service.js';

export const EBAY_QUOTA_BUCKET = 'ebay-global';
export const EBAY_DAILY_REQUEST_LIMIT = 4500;
export const EBAY_DAILY_WINDOW = '1d';
export const EBAY_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What to do when the shared counter cannot be reached. */
export type QuotaFallbackPolicy = 'reject' | 'local';

export interface QuotaBackend {
  increment(bucket: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  read(bucket: string, windowMs: number): Promise<{ count: number; resetAt: number } | null>;
  reset(bucket: string): Promise<void>;
}

export interface QuotaSnapshot {
  bucket: string;
  scope: 'shared' | 'process';
  limit: number;
  count: number;
  remaining: number;
  resetAt: number;
  degraded: boolean;
}

interface LocalBucket {
  count: number;
  resetAt: number;
}

/**
 * The eBay application quota bucket shared by every catalog tool.
 *
 * NitroStack prefixes a RateLimit key with the decorated class and method.
 * This storage deliberately ignores that prefix so search, item, and category
 * calls consume one budget. `@Cache` is applied above `@RateLimit` on those
 * tools, so a cache hit never reaches this counter: the bucket tracks actual
 * eBay requests, not tool invocations.
 *
 * With `DATABASE_URL` configured the counter lives in Postgres, which makes it
 * atomic across replicas and durable across restarts. Without it the counter
 * is process-local and only meaningful for a single-process deployment.
 */
export class EbayQuotaStorage implements RateLimitStorage {
  private backend: QuotaBackend | null = null;
  private fallback: QuotaFallbackPolicy = 'reject';
  private metrics = new MetricsService();
  private bucket?: LocalBucket;
  private degraded = false;

  /** Binds the shared counter. Called once, during module initialization. */
  configure(options: {
    backend: QuotaBackend | null;
    fallback: QuotaFallbackPolicy;
    metrics?: MetricsService;
  }): void {
    this.backend = options.backend;
    this.fallback = options.fallback;
    if (options.metrics) {
      this.metrics = options.metrics;
    }
    this.degraded = false;
  }

  isShared(): boolean {
    return this.backend !== null;
  }

  async increment(_key: string, windowMs: number): Promise<number> {
    let count: number;

    if (this.backend) {
      try {
        const result = await this.backend.increment(EBAY_QUOTA_BUCKET, windowMs);
        this.degraded = false;
        count = result.count;
      } catch {
        this.metrics.recordQuotaBackendFailure();
        this.degraded = true;
        if (this.fallback === 'reject') {
          // Fail closed: without a working shared counter the daily eBay
          // budget cannot be protected, so catalog calls are refused rather
          // than allowed to run unbounded across replicas.
          this.metrics.recordQuotaRejection();
          return Number.MAX_SAFE_INTEGER;
        }
        count = this.incrementLocal(windowMs);
      }
    } else {
      count = this.incrementLocal(windowMs);
    }

    if (count > EBAY_DAILY_REQUEST_LIMIT) {
      this.metrics.recordQuotaRejection();
    }
    return count;
  }

  async reset(_key: string): Promise<void> {
    this.bucket = undefined;
    if (this.backend) {
      await this.backend.reset(EBAY_QUOTA_BUCKET).catch(() => undefined);
    }
  }

  async snapshot(): Promise<QuotaSnapshot> {
    const now = Date.now();

    if (this.backend) {
      try {
        const result = await this.backend.read(EBAY_QUOTA_BUCKET, EBAY_DAILY_WINDOW_MS);
        const count = result?.count ?? 0;
        return {
          bucket: EBAY_QUOTA_BUCKET,
          scope: 'shared',
          limit: EBAY_DAILY_REQUEST_LIMIT,
          count,
          remaining: Math.max(0, EBAY_DAILY_REQUEST_LIMIT - count),
          resetAt: result?.resetAt ?? now + EBAY_DAILY_WINDOW_MS,
          degraded: this.degraded,
        };
      } catch {
        this.metrics.recordQuotaBackendFailure();
        this.degraded = true;
        return {
          bucket: EBAY_QUOTA_BUCKET,
          scope: 'shared',
          limit: EBAY_DAILY_REQUEST_LIMIT,
          count: 0,
          remaining: 0,
          resetAt: now + EBAY_DAILY_WINDOW_MS,
          degraded: true,
        };
      }
    }

    const active = this.bucket && this.bucket.resetAt > now ? this.bucket : undefined;
    const count = active?.count ?? 0;
    return {
      bucket: EBAY_QUOTA_BUCKET,
      scope: 'process',
      limit: EBAY_DAILY_REQUEST_LIMIT,
      count,
      remaining: Math.max(0, EBAY_DAILY_REQUEST_LIMIT - count),
      resetAt: active?.resetAt ?? now + EBAY_DAILY_WINDOW_MS,
      degraded: this.degraded,
    };
  }

  private incrementLocal(windowMs: number): number {
    const now = Date.now();
    if (!this.bucket || this.bucket.resetAt <= now) {
      this.bucket = { count: 1, resetAt: now + windowMs };
      return this.bucket.count;
    }
    this.bucket.count += 1;
    return this.bucket.count;
  }
}

export const ebayQuotaStorage = new EbayQuotaStorage();

/**
 * Binds the quota storage to shared Postgres state when one is configured.
 *
 * The `@RateLimit` decorator resolves its storage when the class is defined,
 * long before the DI container exists, so the backend is attached to the
 * module-level singleton during initialization instead.
 */
@Injectable({ deps: [DatabaseService, ConfigService, MetricsService] })
export class EbayQuotaService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    const shared = this.database.supportsReplicas();
    ebayQuotaStorage.configure({
      backend: shared
        ? {
            increment: (bucket, windowMs) => this.database.incrementQuota(bucket, windowMs),
            read: (bucket, windowMs) => this.database.readQuota(bucket, windowMs),
            reset: (bucket) => this.database.resetQuota(bucket),
          }
        : null,
      fallback: this.getFallbackPolicy(),
      metrics: this.metrics,
    });
  }

  getFallbackPolicy(): QuotaFallbackPolicy {
    return this.config.get<string>('EBAY_QUOTA_FALLBACK', 'reject')?.trim().toLowerCase() === 'local'
      ? 'local'
      : 'reject';
  }

  snapshot(): Promise<QuotaSnapshot> {
    return ebayQuotaStorage.snapshot();
  }
}
