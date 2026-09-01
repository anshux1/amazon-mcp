import { Injectable } from '@nitrostack/core';
import { EbayService } from './ebay.service.js';
import type { CategoryNode, ProductDetails, ProductSummary } from '../../common/types.js';

/** Public catalog facade exported to checkout for live price verification. */
@Injectable({ deps: [EbayService] })
export class ProductsService {
  constructor(private readonly ebay: EbayService) {}

  searchItems(params: {
    query: string;
    categoryId?: string;
    limit: number;
    offset: number;
    sort?: string;
  }): Promise<{
    total: number;
    offset: number;
    limit: number;
    items: ProductSummary[];
    source: 'ebay' | 'demo';
  }> {
    return this.ebay.searchItems(params);
  }

  getItem(itemId: string): Promise<ProductDetails> {
    return this.ebay.getItem(itemId);
  }

  getCategories(categoryId?: string): Promise<{ treeId: string; root: CategoryNode }> {
    return this.ebay.getCategoryTree(categoryId);
  }
}
