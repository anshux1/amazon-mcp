import { Module } from '@nitrostack/core';
import { DatabaseModule } from '../database/database.module.js';
import { ProductsModule } from '../modules/products/products.module.js';
import { MetricsResources } from '../observability/metrics.resources.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { DatabaseHealthCheck } from './database.health.js';
import { EbayHealthCheck } from './ebay.health.js';
import { HttpHealthEndpoints } from './http-health.js';
import { SystemHealthCheck } from './system.health.js';

/** Registers health checks after the configuration provider is available. */
@Module({
  name: 'health',
  description: 'Database, eBay, and process health checks plus the metrics resource',
  imports: [DatabaseModule, ProductsModule, ObservabilityModule],
  controllers: [MetricsResources],
  providers: [SystemHealthCheck, DatabaseHealthCheck, EbayHealthCheck, HttpHealthEndpoints],
})
export class HealthModule {}
