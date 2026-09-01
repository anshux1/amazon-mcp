import {
  Cache,
  ExecutionContext,
  RateLimit,
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
import { LoggingMiddleware } from '../../common/pipeline/logging.middleware.js';
import { ShoppingExceptionFilter } from '../../common/pipeline/exception.filter.js';
import { NormalizeInputPipe } from '../../common/pipeline/normalize-input.pipe.js';
import { ResponseTransformInterceptor } from '../../common/pipeline/response.interceptor.js';
import { EbayService } from './ebay.service.js';

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

type GetProductInput = z.infer<typeof GetProductSchema>;

const GetCategoriesSchema = z.object({
  category_id: z.string().min(1).default('0').describe('Category ID, or 0 for the complete tree'),
});

type GetCategoriesInput = z.infer<typeof GetCategoriesSchema>;

const EBAY_RATE_LIMIT = {
  requests: 4500,
  window: '1d',
  key: () => 'ebay-global',
  message: 'eBay daily request budget is temporarily exhausted; try again tomorrow',
} as const;

@Injectable({ deps: [EbayService] })
export class ProductsTools {
  constructor(private readonly ebay: EbayService) {}

  @Tool({
    name: 'search_products',
    title: 'Search products',
    description: 'Search the eBay catalog for products matching a text query and optional category.',
    inputSchema: SearchProductsSchema,
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
  @RateLimit(EBAY_RATE_LIMIT)
  @Cache({
    ttl: 30,
    key: (input: unknown) => {
      const value = input as SearchProductsInput;
      return `ebay:search:${JSON.stringify(value)}`;
    },
  })
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget('product-search-results')
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
    key: (input: unknown) => `ebay:item:${(input as GetProductInput).item_id}`,
  })
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget('product-card')
  async getProduct(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(GetProductSchema, input);
    ctx.logger.info('Fetching eBay product', { itemId: value.item_id });
    return this.ebay.getItem(value.item_id);
  }

  @Tool({
    name: 'get_categories',
    title: 'Get product categories',
    description: 'Retrieve the eBay category tree, or a category subtree when category_id is supplied.',
    inputSchema: GetCategoriesSchema,
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
  @RateLimit(EBAY_RATE_LIMIT)
  @Cache({
    ttl: 3600,
    key: (input: unknown) => `ebay:categories:${(input as GetCategoriesInput).category_id}`,
  })
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

export { GetCategoriesSchema, GetProductSchema, SearchProductsSchema };
