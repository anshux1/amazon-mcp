import { Module } from '@nitrostack/core';
import { DatabaseModule } from '../database/database.module.js';
import { ProductsModule } from '../modules/products/products.module.js';
import { DatabaseHealthCheck } from './database.health.js';
import { EbayHealthCheck } from './ebay.health.js';
import { SystemHealthCheck } from './system.health.js';

/** Registers health checks after the configuration provider is available. */
@Module({
  name: 'health',
  description: 'Database, eBay, and process health checks',
  imports: [DatabaseModule, ProductsModule],
  providers: [SystemHealthCheck, DatabaseHealthCheck, EbayHealthCheck],
})
export class HealthModule {}
