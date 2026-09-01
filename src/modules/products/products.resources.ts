import { ResourceDecorator as Resource, type ExecutionContext, Injectable } from '@nitrostack/core';
import { ProductsService } from './products.service.js';

@Injectable({ deps: [ProductsService] })
export class ProductsResources {
  constructor(private readonly products: ProductsService) {}

  @Resource({
    uri: 'shopping://catalog-guide',
    name: 'Shopping Catalog Guide',
    description: 'How to search eBay products and safely inspect current item details.',
    mimeType: 'text/markdown',
    metadata: { cacheable: true, cacheMaxAge: 3600000 },
    examples: {
      response: '# Shopping Catalog Guide\n\nUse search_products before get_product.',
    },
  })
  async getCatalogGuide(_uri: string, _ctx: ExecutionContext): Promise<string> {
    return `# Shopping Catalog Guide

1. Use \`search_products\` with a natural-language query.
2. Use \`get_product\` with the returned \`itemId\` before adding an item to a cart.
3. Product prices and availability are rechecked during \`checkout\`.
4. Use \`get_categories\` when a category filter is useful.

Catalog results come from eBay when credentials are configured. Local development uses the
explicit demo catalog when \`EBAY_MOCK=true\` or credentials are absent.
`;
  }

  @Resource({
    uri: 'shopping://featured-products',
    name: 'Featured Products',
    description: 'A small catalog sample for demos and clients that need an initial shopping view.',
    mimeType: 'application/json',
    metadata: { cacheable: true, cacheMaxAge: 300000 },
    examples: {
      response: { source: 'demo', items: [] },
    },
  })
  async getFeaturedProducts(_uri: string, _ctx: ExecutionContext) {
    return this.products.searchItems({
      query: 'demo',
      limit: 10,
      offset: 0,
    });
  }

  @Resource({
    uri: 'shopping://categories',
    name: 'Shopping Categories',
    description: 'The current eBay category tree used by the product search tool.',
    mimeType: 'application/json',
    metadata: { cacheable: true, cacheMaxAge: 3600000 },
    examples: {
      response: { treeId: '0', root: { categoryId: '0', categoryName: 'All Categories', children: [] } },
    },
  })
  async getCategories(_uri: string, _ctx: ExecutionContext) {
    return this.products.getCategories('0');
  }
}
