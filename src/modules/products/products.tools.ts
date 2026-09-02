import {
  Cache,
  ExecutionContext,
  RateLimit,
  type RateLimitStorage,
  ToolDecorator as Tool,
  UseFilters,
  UseInterceptors,
  UseMiddleware,
  UsePipes,
  Widget,
  z,
  Injectable,
} from '@nitrostack/core';
import { parseInput } from '../../common/validation.js';
import {
  CategoryTreeOutputSchema,
  ProductDetailsOutputSchema,
  SearchResultOutputSchema,
  standardOutput,
} from '../../common/output-schema.js';
import { EBAY_IMAGE_CSP } from '../../config/widget-csp.js';
import { InstrumentedCacheStorage } from '../../observability/metrics.service.js';
import { LoggingMiddleware } from '../../common/pipeline/logging.middleware.js';
import { ShoppingExceptionFilter } from '../../common/pipeline/exception.filter.js';
import { NormalizeInputPipe } from '../../common/pipeline/normalize-input.pipe.js';
import { ResponseTransformInterceptor } from '../../common/pipeline/response.interceptor.js';
import { EbayService } from './ebay.service.js';
import {
  EBAY_DAILY_REQUEST_LIMIT,
  EBAY_DAILY_WINDOW,
  EBAY_QUOTA_BUCKET,
  ebayQuotaStorage,
} from './ebay-quota.js';

const SearchProductsSchema = z.object({
  query: z.string().min(1).max(200).describe('Words to search for, such as wireless headphones'),
  category_id: z.string().min(1).optional().describe('Optional eBay category ID'),
  limit: z.number().int().min(1).max(50).default(10).describe('Number of products to return'),
  offset: z.number().int().min(0).max(10000).default(0).describe('Number of products to skip'),
  sort: z.enum(['best_match', 'price', '-price', 'newlyListed', 'endingSoonest']).optional()
    .describe('Optional eBay sort order'),
});

type SearchProductsInput = z.infer<typeof SearchProductsSchema>;

const GetProductSchema = z.object({
  item_id: z.string().min(1).max(200).describe('eBay item ID, for example v1|123|0'),
});

const GetCategoriesSchema = z.object({
  category_id: z.string().min(1).default('0').describe('Category ID, or 0 for the complete tree'),
});

// Catalog responses are cached separately from the framework's shared default
// storage so hit and miss counts can be reported by metrics://shopping.
const catalogCache = new InstrumentedCacheStorage('catalog');

const EBAY_RATE_LIMIT = {
  requests: EBAY_DAILY_REQUEST_LIMIT,
  window: EBAY_DAILY_WINDOW,
  key: () => EBAY_QUOTA_BUCKET,
  storage: ebayQuotaStorage as RateLimitStorage,
  message: 'eBay daily request budget is temporarily exhausted; try again tomorrow',
} as const;

/**
 * Builds a cache key from catalog parameters only. Request metadata may hold a
 * bearer token and is never allowed into a cache key.
 */
export function buildSearchProductsCacheKey(input: unknown): string {
  const value = input && typeof input === 'object'
    ? input as Partial<SearchProductsInput>
    : {};
  const sort = typeof value.sort === 'string' && [
    'best_match',
    'price',
    '-price',
    'newlyListed',
    'endingSoonest',
  ].includes(value.sort)
    ? value.sort
    : null;

  return `ebay:search:${JSON.stringify({
    query: typeof value.query === 'string' ? value.query.trim().toLowerCase() : '',
    category_id: typeof value.category_id === 'string' ? value.category_id.trim() : null,
    limit: typeof value.limit === 'number' && Number.isInteger(value.limit) ? value.limit : 10,
    offset: typeof value.offset === 'number' && Number.isInteger(value.offset) ? value.offset : 0,
    sort,
  })}`;
}

export function buildGetProductCacheKey(input: unknown): string {
  const itemId = input && typeof input === 'object' && 'item_id' in input
    ? (input as { item_id?: unknown }).item_id
    : undefined;
  return `ebay:item:${typeof itemId === 'string' ? itemId.trim() : ''}`;
}

export function buildGetCategoriesCacheKey(input: unknown): string {
  const categoryId = input && typeof input === 'object' && 'category_id' in input
    ? (input as { category_id?: unknown }).category_id
    : undefined;
  return `ebay:categories:${typeof categoryId === 'string' ? categoryId.trim() : '0'}`;
}

@Injectable({ deps: [EbayService] })
export class ProductsTools {
  constructor(private readonly ebay: EbayService) {}

  @Tool({
    name: 'search_products',
    title: 'Search products',
    description: 'Search the eBay catalog for products matching a text query and optional category.',
    inputSchema: SearchProductsSchema,
    outputSchema: standardOutput(SearchResultOutputSchema),
    examples: {
      request: { query: 'wireless headphones', limit: 5 },
      response: {
        success: true,
        data: {
          total: 1,
          offset: 0,
          limit: 5,
          source: 'ebay',
          items: [{ itemId: 'v1|123|0', title: 'Wireless Headphones', price: 79.99, currency: 'USD' }],
        },
      },
    },
  })
  // @Cache is listed above @RateLimit so it wraps it: a cache hit returns
  // without touching the eBay quota, which therefore counts eBay requests
  // rather than tool invocations.
  @Cache({
    ttl: 30,
    key: buildSearchProductsCacheKey,
    storage: catalogCache,
  })
  @RateLimit(EBAY_RATE_LIMIT)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget({ route: 'product-search-results', csp: EBAY_IMAGE_CSP })
  async searchProducts(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(SearchProductsSchema, input);
    ctx.logger.info('Searching eBay products', {
      query: value.query,
      categoryId: value.category_id,
      limit: value.limit,
      offset: value.offset,
    });
    return this.ebay.searchItems({
      query: value.query,
      categoryId: value.category_id,
      limit: value.limit ?? 10,
      offset: value.offset ?? 0,
      sort: value.sort,
    });
  }

  @Tool({
    name: 'get_product',
    title: 'Get product',
    description: 'Retrieve current details and pricing for one eBay item.',
    inputSchema: GetProductSchema,
    outputSchema: standardOutput(ProductDetailsOutputSchema),
    examples: {
      request: { item_id: 'v1|123|0' },
      response: {
        success: true,
        data: {
          itemId: 'v1|123|0',
          title: 'Wireless Headphones',
          price: 79.99,
          currency: 'USD',
          availableQuantity: 4,
        },
      },
    },
  })
  @Cache({
    ttl: 120,
    key: buildGetProductCacheKey,
    storage: catalogCache,
  })
  @RateLimit(EBAY_RATE_LIMIT)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget({ route: 'product-card', csp: EBAY_IMAGE_CSP })
  async getProduct(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(GetProductSchema, input);
    ctx.logger.info('Fetching eBay product', { itemId: value.item_id });
    return this.ebay.getItem(value.item_id);
  }

  @Tool({
    name: 'get_categories',
    title: 'Get product categories',
    description: 'Retrieve the eBay category tree, or a category subtree when category_id is supplied. Deep trees are truncated to keep responses within practical client limits.',
    inputSchema: GetCategoriesSchema,
    outputSchema: standardOutput(CategoryTreeOutputSchema),
    examples: {
      request: { category_id: '0' },
      response: {
        success: true,
        data: {
          treeId: '0',
          root: {
            categoryId: '0',
            categoryName: 'All Categories',
            children: [{ categoryId: '293', categoryName: 'Consumer Electronics', children: [] }],
          },
        },
      },
    },
  })
  @Cache({
    ttl: 3600,
    key: buildGetCategoriesCacheKey,
    storage: catalogCache,
  })
  @RateLimit(EBAY_RATE_LIMIT)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget('category-tree')
  async getCategories(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(GetCategoriesSchema, input);
    ctx.logger.info('Fetching eBay category tree', { categoryId: value.category_id });
    return this.ebay.getCategoryTree(value.category_id);
  }
}

export { catalogCache, GetCategoriesSchema, GetProductSchema, SearchProductsSchema };
