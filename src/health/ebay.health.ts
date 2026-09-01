import { HealthCheck, Injectable, type HealthCheckInterface, type HealthCheckResult } from '@nitrostack/core';
import { EbayService } from '../modules/products/ebay.service.js';

@Injectable({ deps: [EbayService] })
@HealthCheck({
  name: 'ebay',
  description: 'eBay application-token connectivity and catalog configuration',
  interval: 60,
})
export class EbayHealthCheck implements HealthCheckInterface {
  constructor(private readonly ebay: EbayService) {}

  async check(): Promise<HealthCheckResult> {
    try {
      const result = await this.ebay.ping();
      return {
        status: result.configured ? 'up' : 'degraded',
        message: result.configured
          ? 'eBay application token is available'
          : 'Running with the explicit offline demo catalog',
        details: result,
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        status: 'down',
        message: 'eBay connectivity check failed',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
        timestamp: Date.now(),
      };
    }
  }
}
