import { Module } from '@nitrostack/core';
import { EbayService } from './ebay.service.js';
import { ProductsPrompts } from './products.prompts.js';
import { ProductsResources } from './products.resources.js';
import { ProductsService } from './products.service.js';
import { ProductsTools } from './products.tools.js';

@Module({
  name: 'products',
  description: 'eBay Browse and Taxonomy catalog access',
  controllers: [ProductsTools, ProductsResources, ProductsPrompts],
  providers: [EbayService, ProductsService],
  exports: [EbayService, ProductsService],
})
export class ProductsModule {}
