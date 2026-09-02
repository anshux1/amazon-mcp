import { HealthCheck, Injectable, type HealthCheckInterface, type HealthCheckResult } from '@nitrostack/core';
import { EbayQuotaService } from '../modules/products/ebay-quota.js';
import { EbayService } from '../modules/products/ebay.service.js';
import {
  EBAY_FAILURE_ALERT_THRESHOLD,
  MetricsResources,
} from '../observability/metrics.resources.js';
import { MetricsService } from '../observability/metrics.service.js';

@Injectable({ deps: [EbayService, EbayQuotaService, MetricsService] })
@HealthCheck({
  name: 'ebay',
  description: 'eBay application-token connectivity, catalog configuration, and daily quota',
  interval: 60,
})
export class EbayHealthCheck implements HealthCheckInterface {
  constructor(
    private readonly ebay: EbayService,
    private readonly quota: EbayQuotaService,
    private readonly metrics: MetricsService,
  ) {}

  async check(): Promise<HealthCheckResult> {
    const quota = await this.quota.snapshot().catch(() => null);
    const quotaDetails = quota
      ? {
          quotaScope: quota.scope,
          quotaRemaining: quota.remaining,
          quotaLimit: quota.limit,
          quotaResetAt: new Date(quota.resetAt).toISOString(),
          quotaDegraded: quota.degraded,
        }
      : { quotaScope: 'unknown' as const };

    try {
      const result = await this.ebay.ping();
      const consecutiveFailures = this.metrics.getConsecutiveEbayFailures();
      const alerts = MetricsResources.evaluateAlerts({
        consecutiveEbayFailures: consecutiveFailures,
        quotaRemaining: quota?.remaining ?? Number.MAX_SAFE_INTEGER,
        quotaLimit: quota?.limit ?? 1,
        quotaDegraded: quota?.degraded ?? false,
      });
      const critical = alerts.some((alert) => alert.severity === 'critical');

      // A configured dependency that is answering but exhausted or repeatedly
      // failing is degraded, not down: the process is healthy and other tools
      // keep working.
      const status = !result.configured || alerts.length > 0 ? 'degraded' : 'up';
      return {
        status,
        message: !result.configured
          ? 'Running with the explicit offline demo catalog'
          : critical
            ? 'eBay dependency is impaired'
            : alerts.length > 0
              ? 'eBay dependency is approaching a limit'
              : 'eBay application token is available',
        details: {
          ...result,
          ...quotaDetails,
          consecutiveFailures,
          alerts,
        },
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        status: 'down',
        message: 'eBay connectivity check failed',
        details: {
          ...quotaDetails,
          consecutiveFailures: this.metrics.getConsecutiveEbayFailures(),
          failureThreshold: EBAY_FAILURE_ALERT_THRESHOLD,
          // ExternalServiceError messages are already sanitized upstream.
          error: error instanceof Error ? error.message : 'eBay connectivity check failed',
        },
        timestamp: Date.now(),
      };
    }
  }
}
