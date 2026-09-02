import { Module } from '@nitrostack/core';
import { DatabaseModule } from '../../database/database.module.js';
import { ObservabilityModule } from '../../observability/observability.module.js';
import { EbayQuotaService } from './ebay-quota.js';
import { EbayService } from './ebay.service.js';
import { ProductsPrompts } from './products.prompts.js';
import { ProductsResources } from './products.resources.js';
import { ProductsService } from './products.service.js';
import { ProductsTools } from './products.tools.js';

@Module({
  name: 'products',
  description: 'eBay Browse and Taxonomy catalog access',
  imports: [DatabaseModule, ObservabilityModule],
  controllers: [ProductsTools, ProductsResources, ProductsPrompts],
  providers: [EbayService, ProductsService, EbayQuotaService],
  exports: [EbayService, ProductsService, EbayQuotaService],
})
export class ProductsModule {}
