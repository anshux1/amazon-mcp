import { ResourceDecorator as Resource, type ExecutionContext, Injectable } from '@nitrostack/core';
import { DatabaseService } from '../database/database.service.js';
import { EbayQuotaService } from '../modules/products/ebay-quota.js';
import { MetricsService } from './metrics.service.js';

/** Sustained failures above this count mark the eBay dependency unhealthy. */
export const EBAY_FAILURE_ALERT_THRESHOLD = 10;
/** Remaining daily eBay budget below this fraction raises a quota alert. */
export const EBAY_QUOTA_ALERT_FRACTION = 0.1;

export interface ShoppingAlert {
  name: string;
  severity: 'warning' | 'critical';
  message: string;
}

@Injectable({ deps: [MetricsService, EbayQuotaService, DatabaseService] })
export class MetricsResources {
  constructor(
    private readonly metrics: MetricsService,
    private readonly quota: EbayQuotaService,
    private readonly database: DatabaseService,
  ) {}

  /**
   * Evaluates the alert conditions an operator needs to page on: a dependency
   * that keeps failing, and a daily budget about to run out.
   */
  static evaluateAlerts(input: {
    consecutiveEbayFailures: number;
    quotaRemaining: number;
    quotaLimit: number;
    quotaDegraded: boolean;
  }): ShoppingAlert[] {
    const alerts: ShoppingAlert[] = [];

    if (input.consecutiveEbayFailures >= EBAY_FAILURE_ALERT_THRESHOLD) {
      alerts.push({
        name: 'ebay_sustained_failures',
        severity: 'critical',
        message: `${input.consecutiveEbayFailures} consecutive eBay requests failed`,
      });
    }
    if (input.quotaRemaining <= 0) {
      alerts.push({
        name: 'ebay_quota_exhausted',
        severity: 'critical',
        message: 'The daily eBay application budget is exhausted; catalog tools are rejecting requests',
      });
    } else if (input.quotaRemaining <= input.quotaLimit * EBAY_QUOTA_ALERT_FRACTION) {
      alerts.push({
        name: 'ebay_quota_low',
        severity: 'warning',
        message: `Only ${input.quotaRemaining} eBay requests remain in the current daily window`,
      });
    }
    if (input.quotaDegraded) {
      alerts.push({
        name: 'ebay_quota_backend_unavailable',
        severity: 'critical',
        message: 'The shared eBay quota counter is unreachable',
      });
    }

    return alerts;
  }

  @Resource({
    uri: 'metrics://shopping',
    name: 'Shopping Metrics',
    description:
      'Tool, eBay dependency, cache, and quota counters. Contains names, counts, and durations only: never tokens, credentials, or shopper data.',
    mimeType: 'application/json',
    metadata: { cacheable: false },
    examples: {
      response: {
        tools: {},
        ebay: { totalRequests: 0, totalFailures: 0 },
        quota: { remaining: 4500 },
        alerts: [],
      },
    },
  })
  async getMetrics(_uri: string, _ctx: ExecutionContext) {
    const snapshot = this.metrics.snapshot();
    const quota = await this.quota.snapshot();

    return {
      ...snapshot,
      quota: {
        ...snapshot.quota,
        bucket: quota.bucket,
        scope: quota.scope,
        limit: quota.limit,
        used: quota.count,
        remaining: quota.remaining,
        resetAt: new Date(quota.resetAt).toISOString(),
        degraded: quota.degraded,
      },
      storage: {
        mode: this.database.getMode(),
        supportsReplicas: this.database.supportsReplicas(),
        appliedMigrations: this.database.getAppliedMigrations(),
      },
      alerts: MetricsResources.evaluateAlerts({
        consecutiveEbayFailures: this.metrics.getConsecutiveEbayFailures(),
        quotaRemaining: quota.remaining,
        quotaLimit: quota.limit,
        quotaDegraded: quota.degraded,
      }),
    };
  }
}
