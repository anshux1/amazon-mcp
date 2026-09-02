import { ConfigService, Injectable } from '@nitrostack/core';
import { EbayService } from './ebay.service.js';
import type { CategoryNode, ProductDetails, ProductSummary } from '../../common/types.js';

export const DEFAULT_FEATURED_QUERY = 'best selling';
export const DEFAULT_FEATURED_LIMIT = 10;

export interface CategoryTreeResult {
  treeId: string;
  root: CategoryNode;
  truncated: boolean;
  depth: number;
}

export interface FeaturedProducts {
  source: 'ebay' | 'demo';
  strategy: 'demo_catalog' | 'configured_items' | 'catalog_query';
  query?: string;
  items: ProductSummary[];
  unavailableItemIds?: string[];
}

/** Public catalog facade exported to checkout for live price verification. */
@Injectable({ deps: [EbayService, ConfigService] })
export class ProductsService {
  constructor(
    private readonly ebay: EbayService,
    private readonly config: ConfigService,
  ) {}

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

  getCategories(categoryId?: string): Promise<CategoryTreeResult> {
    return this.ebay.getCategoryTree(categoryId);
  }

  /**
   * Resolves the featured selection deterministically in every mode.
   *
   * Demo mode returns the offline catalog. A live deployment returns an
   * explicitly curated `SHOPPING_FEATURED_ITEM_IDS` list when one is
   * configured, and otherwise a fixed catalog query — never a placeholder
   * search term that happens to match the demo data.
   */
  async getFeatured(): Promise<FeaturedProducts> {
    const limit = this.getFeaturedLimit();

    if (this.ebay.isMockEnabled()) {
      return {
        source: 'demo',
        strategy: 'demo_catalog',
        items: this.sortById(this.ebay.listDemoProducts()).slice(0, limit),
      };
    }

    const itemIds = this.getFeaturedItemIds().slice(0, limit);
    if (itemIds.length > 0) {
      const results = await Promise.allSettled(itemIds.map((itemId) => this.ebay.getItem(itemId)));
      const items: ProductSummary[] = [];
      const unavailableItemIds: string[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          items.push(result.value);
        } else {
          // A delisted curated item must not break the whole resource.
          unavailableItemIds.push(itemIds[index]);
        }
      });
      return {
        source: 'ebay',
        strategy: 'configured_items',
        items,
        ...(unavailableItemIds.length > 0 ? { unavailableItemIds } : {}),
      };
    }

    const query = this.config.get<string>('SHOPPING_FEATURED_QUERY', DEFAULT_FEATURED_QUERY)?.trim()
      || DEFAULT_FEATURED_QUERY;
    const result = await this.ebay.searchItems({ query, limit, offset: 0, sort: 'best_match' });
    return {
      source: result.source,
      strategy: 'catalog_query',
      query,
      items: this.sortById(result.items),
    };
  }

  private sortById<T extends { itemId: string }>(items: T[]): T[] {
    return [...items].sort((left, right) => left.itemId.localeCompare(right.itemId));
  }

  private getFeaturedItemIds(): string[] {
    const configured = this.config.get<string>('SHOPPING_FEATURED_ITEM_IDS', '') ?? '';
    return configured
      .split(',')
      .map((itemId) => itemId.trim())
      .filter((itemId) => itemId.length > 0);
  }

  private getFeaturedLimit(): number {
    const parsed = Number(this.config.get<string>('SHOPPING_FEATURED_LIMIT', String(DEFAULT_FEATURED_LIMIT)));
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : DEFAULT_FEATURED_LIMIT;
  }
}
