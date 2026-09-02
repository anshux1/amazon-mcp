import eBayApi from 'ebay-api';
import { ConfigService, Injectable } from '@nitrostack/core';
import { ExternalServiceError, NotFoundError } from '../../common/errors.js';
import { parseMoney } from '../../common/money.js';
import type { CategoryNode, ProductDetails, ProductSummary } from '../../common/types.js';

export interface EbaySearchParams {
  query: string;
  categoryId?: string;
  limit: number;
  offset: number;
  sort?: string;
}

export interface EbaySearchResult {
  total: number;
  offset: number;
  limit: number;
  items: ProductSummary[];
  source: 'ebay' | 'demo';
}

interface EbayClientLike {
  buy: {
    browse: {
      search(params: Record<string, string>): Promise<unknown>;
      getItem(itemId: string): Promise<unknown>;
    };
  };
  commerce: {
    taxonomy: {
      getDefaultCategoryTreeId(marketplaceId: string): Promise<unknown>;
      getCategoryTree(categoryTreeId: string): Promise<unknown>;
      getCategorySubtree(categoryTreeId: string, categoryId: string): Promise<unknown>;
    };
  };
  oAuth2: {
    getApplicationAccessToken(): Promise<string>;
  };
}

const DEMO_PRODUCTS: ProductDetails[] = [
  {
    itemId: 'demo-wireless-headphones',
    title: 'Wireless Noise-Cancelling Headphones',
    price: 79.99,
    currency: 'USD',
    imageUrl: 'https://i.ebayimg.com/images/g/demo-headphones/s-l400.jpg',
    itemWebUrl: 'https://www.ebay.com/',
    condition: 'Brand New',
    categoryId: '293',
    availableQuantity: 24,
    seller: { username: 'demo-electronics', feedbackPercentage: 99.8 },
    description: 'Comfortable wireless headphones with active noise cancellation and a 30-hour battery.',
    additionalImageUrls: [],
    shipping: { value: 0, currency: 'USD' },
    location: 'United States',
    buyingOptions: ['FIXED_PRICE'],
    lastUpdated: '2025-01-01T00:00:00.000Z',
  },
  {
    itemId: 'demo-mechanical-keyboard',
    title: 'Compact Mechanical Keyboard RGB',
    price: 54.5,
    currency: 'USD',
    imageUrl: 'https://i.ebayimg.com/images/g/demo-keyboard/s-l400.jpg',
    itemWebUrl: 'https://www.ebay.com/',
    condition: 'New',
    categoryId: '33963',
    availableQuantity: 18,
    seller: { username: 'demo-computers', feedbackPercentage: 100 },
    description: 'A compact mechanical keyboard with hot-swappable switches and programmable RGB lighting.',
    additionalImageUrls: [],
    shipping: { value: 4.99, currency: 'USD' },
    location: 'United States',
    buyingOptions: ['FIXED_PRICE'],
    lastUpdated: '2025-01-01T00:00:00.000Z',
  },
  {
    itemId: 'demo-travel-backpack',
    title: 'Water-Resistant Travel Backpack 28L',
    price: 42,
    currency: 'USD',
    imageUrl: 'https://i.ebayimg.com/images/g/demo-backpack/s-l400.jpg',
    itemWebUrl: 'https://www.ebay.com/',
    condition: 'New with tags',
    categoryId: '169291',
    availableQuantity: 31,
    seller: { username: 'demo-outdoors', feedbackPercentage: 99.4 },
    description: 'A lightweight 28L travel backpack with a padded laptop sleeve and luggage pass-through.',
    additionalImageUrls: [],
    shipping: { value: 0, currency: 'USD' },
    location: 'United States',
    buyingOptions: ['FIXED_PRICE'],
    lastUpdated: '2025-01-01T00:00:00.000Z',
  },
  {
    itemId: 'demo-smartwatch',
    title: 'Fitness Smartwatch with Heart-Rate Monitor',
    price: 64.95,
    currency: 'USD',
    imageUrl: 'https://i.ebayimg.com/images/g/demo-watch/s-l400.jpg',
    itemWebUrl: 'https://www.ebay.com/',
    condition: 'New',
    categoryId: '178893',
    availableQuantity: 12,
    seller: { username: 'demo-gadgets', feedbackPercentage: 98.9 },
    description: 'Fitness smartwatch with activity tracking, heart-rate monitoring, and seven-day battery life.',
    additionalImageUrls: [],
    shipping: { value: 3.99, currency: 'USD' },
    location: 'United States',
    buyingOptions: ['FIXED_PRICE'],
    lastUpdated: '2025-01-01T00:00:00.000Z',
  },
  {
    itemId: 'demo-coffee-maker',
    title: 'Programmable Drip Coffee Maker 12-Cup',
    price: 39.99,
    currency: 'USD',
    imageUrl: 'https://i.ebayimg.com/images/g/demo-coffee/s-l400.jpg',
    itemWebUrl: 'https://www.ebay.com/',
    condition: 'New',
    categoryId: '20667',
    availableQuantity: 9,
    seller: { username: 'demo-home', feedbackPercentage: 99.1 },
    description: 'Programmable 12-cup coffee maker with a reusable filter and automatic shutoff.',
    additionalImageUrls: [],
    shipping: { value: 6.99, currency: 'USD' },
    location: 'United States',
    buyingOptions: ['FIXED_PRICE'],
    lastUpdated: '2025-01-01T00:00:00.000Z',
  },
];

const DEMO_CATEGORIES: CategoryNode = {
  categoryId: '0',
  categoryName: 'All Categories',
  children: [
    { categoryId: '293', categoryName: 'Consumer Electronics', children: [] },
    { categoryId: '33963', categoryName: 'Computers/Tablets & Networking', children: [] },
    { categoryId: '169291', categoryName: 'Travel', children: [] },
    { categoryId: '178893', categoryName: 'Wearable Technology', children: [] },
    { categoryId: '20667', categoryName: 'Small Kitchen Appliances', children: [] },
  ],
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const record = asRecord(error);
  return typeof record.message === 'string' ? record.message : 'Unknown eBay error';
}

function normalizeProduct(rawValue: unknown): ProductDetails {
  const raw = asRecord(rawValue);
  const price = asRecord(raw.price ?? raw.currentBidPrice);
  const seller = asRecord(raw.seller);
  const shipping = asRecord(raw.shippingOptions?.[0]?.shippingCost);
  const additionalImageUrls = Array.isArray(raw.additionalImages)
    ? raw.additionalImages
        .map((image: unknown) => asRecord(image).imageUrl)
        .filter((url: unknown): url is string => typeof url === 'string')
    : [];
  const availability = asRecord(raw.availability);
  const shipToAvailability = asRecord(availability.shipToLocationAvailability);
  const estimatedAvailability = Array.isArray(raw.estimatedAvailabilities)
    ? asRecord(raw.estimatedAvailabilities[0])
    : {};
  const category = Array.isArray(raw.categories) ? asRecord(raw.categories[0]) : {};
  const sellerUsername = typeof seller.username === 'string' ? seller.username : undefined;
  const sellerFeedback = seller.feedbackPercentage === undefined
    ? undefined
    : parseMoney(seller.feedbackPercentage);
  const normalizedSeller = sellerUsername || sellerFeedback !== undefined
    ? { username: sellerUsername, feedbackPercentage: sellerFeedback }
    : undefined;
  const availableQuantity =
    typeof shipToAvailability.quantity === 'number'
      ? shipToAvailability.quantity
      : typeof estimatedAvailability.estimatedAvailableQuantity === 'number'
        ? estimatedAvailability.estimatedAvailableQuantity
        : typeof estimatedAvailability.estimatedRemainingQuantity === 'number'
          ? estimatedAvailability.estimatedRemainingQuantity
          : null;

  const itemId = typeof raw.itemId === 'string' ? raw.itemId : '';
  return {
    itemId,
    title: typeof raw.title === 'string' ? raw.title : 'Untitled eBay item',
    price: parseMoney(price.value),
    currency: typeof price.currency === 'string' ? price.currency : 'USD',
    imageUrl: typeof raw.image?.imageUrl === 'string' ? raw.image.imageUrl : undefined,
    itemWebUrl: typeof raw.itemWebUrl === 'string' ? raw.itemWebUrl : undefined,
    condition: typeof raw.condition === 'string' ? raw.condition : undefined,
    categoryId:
      typeof raw.categoryId === 'string'
        ? raw.categoryId
        : typeof category.categoryId === 'string'
          ? category.categoryId
          : undefined,
    availableQuantity,
    seller: normalizedSeller,
    description:
      typeof raw.shortDescription === 'string'
        ? raw.shortDescription
        : typeof raw.description === 'string'
          ? raw.description
          : undefined,
    additionalImageUrls,
    shipping: typeof shipping.value !== 'undefined'
      ? {
          value: parseMoney(shipping.value),
          currency: typeof shipping.currency === 'string' ? shipping.currency : 'USD',
        }
      : undefined,
    location: typeof raw.itemLocation?.city === 'string' ? raw.itemLocation.city : undefined,
    buyingOptions: Array.isArray(raw.buyingOptions)
      ? raw.buyingOptions.filter((option: unknown): option is string => typeof option === 'string')
      : [],
    lastUpdated: new Date().toISOString(),
  };
}

function normalizeCategory(rawValue: unknown): CategoryNode {
  const raw = asRecord(rawValue);
  const children = Array.isArray(raw.childCategoryTreeNodes)
    ? raw.childCategoryTreeNodes.map(normalizeCategory)
    : [];
  const category = asRecord(raw.category);
  return {
    categoryId:
      typeof category.categoryId === 'string'
        ? category.categoryId
        : typeof raw.categoryId === 'string'
          ? raw.categoryId
          : '',
    categoryName:
      typeof category.categoryName === 'string'
        ? category.categoryName
        : typeof raw.categoryName === 'string'
          ? raw.categoryName
          : 'Unnamed category',
    children,
  };
}

/** eBay Browse and Taxonomy API adapter with an explicit offline demo mode. */
@Injectable({ deps: [ConfigService] })
export class EbayService {
  private readonly client: EbayClientLike | null;
  private readonly marketplaceId: string;
  private readonly mockEnabled: boolean;

  constructor(config: ConfigService, client?: EbayClientLike) {
    this.marketplaceId = config.get<string>('EBAY_MARKETPLACE_ID', 'EBAY_US');

    const mockSetting = config.get<string>('EBAY_MOCK');
    const mockRequested = mockSetting?.trim().toLowerCase() === 'true';
    const appId = config.get<string>('EBAY_APP_ID')?.trim();
    const certId = config.get<string>('EBAY_CERT_ID')?.trim();
    const credentialsMissing = !appId || !certId;
    const nodeEnv = config.get<string>('NODE_ENV')?.trim().toLowerCase();
    const developmentEnvironment = !nodeEnv || nodeEnv === 'development' || nodeEnv === 'dev';
    const implicitDevelopmentDemo = developmentEnvironment && mockSetting === undefined && credentialsMissing;

    if (!client && !mockRequested && credentialsMissing && !implicitDevelopmentDemo) {
      // Keep this message free of credential values. ConfigModule validation
      // normally catches it first, but the service also fails closed when
      // constructed directly in a test or another application.
      throw new Error('eBay credentials are required when EBAY_MOCK is not true');
    }

    this.mockEnabled = !client && (mockRequested || implicitDevelopmentDemo);

    if (client) {
      this.client = client;
    } else if (!this.mockEnabled) {
      this.client = new eBayApi({
        appId: appId as string,
        certId: certId as string,
        devId: config.get<string>('EBAY_DEV_ID'),
        marketplaceId: this.marketplaceId as any,
        sandbox: config.get<string>('EBAY_SANDBOX', 'false') === 'true',
      });
    } else {
      this.client = null;
    }
  }

  isMockEnabled(): boolean {
    return this.mockEnabled;
  }

  isConfigured(): boolean {
    return this.client !== null && !this.mockEnabled;
  }

  async searchItems(params: EbaySearchParams): Promise<EbaySearchResult> {
    if (this.mockEnabled || !this.client) {
      const query = params.query.toLowerCase();
      const filtered = DEMO_PRODUCTS.filter((product) => {
        const matchesQuery = `${product.title} ${product.description ?? ''} ${product.itemId}`
          .toLowerCase()
          .includes(query);
        const matchesCategory = !params.categoryId || product.categoryId === params.categoryId;
        return matchesQuery && matchesCategory;
      });
      const sorted = params.sort === 'price'
        ? [...filtered].sort((a, b) => a.price - b.price)
        : params.sort === '-price'
          ? [...filtered].sort((a, b) => b.price - a.price)
          : filtered;
      return {
        total: sorted.length,
        offset: params.offset,
        limit: params.limit,
        items: sorted.slice(params.offset, params.offset + params.limit),
        source: 'demo',
      };
    }

    try {
      const query: Record<string, string> = {
        q: params.query,
        limit: String(params.limit),
        offset: String(params.offset),
      };
      if (params.categoryId) query.category_ids = params.categoryId;
      if (params.sort) query.sort = params.sort;
      const result = asRecord(await this.client.buy.browse.search(query));
      const rawItems = Array.isArray(result.itemSummaries) ? result.itemSummaries : [];
      return {
        total: typeof result.total === 'number' ? result.total : rawItems.length,
        offset: params.offset,
        limit: params.limit,
        items: rawItems.map(normalizeProduct),
        source: 'ebay',
      };
    } catch (error) {
      throw new ExternalServiceError('eBay Browse API', errorMessage(error));
    }
  }

  async getItem(itemId: string): Promise<ProductDetails> {
    if (this.mockEnabled || !this.client) {
      const product = DEMO_PRODUCTS.find((candidate) => candidate.itemId === itemId);
      if (!product) {
        throw new NotFoundError('Product', itemId);
      }
      return structuredClone(product);
    }

    try {
      return normalizeProduct(await this.client.buy.browse.getItem(itemId));
    } catch (error) {
      const message = errorMessage(error);
      if (/not found|404/i.test(message)) {
        throw new NotFoundError('Product', itemId);
      }
      throw new ExternalServiceError('eBay Browse API', message);
    }
  }

  async getCategoryTree(categoryId?: string): Promise<{ treeId: string; root: CategoryNode }> {
    if (this.mockEnabled || !this.client) {
      if (categoryId && categoryId !== '0') {
        const child = DEMO_CATEGORIES.children.find((candidate) => candidate.categoryId === categoryId);
        if (!child) throw new NotFoundError('Category', categoryId);
        return { treeId: 'demo-us', root: structuredClone(child) };
      }
      return { treeId: 'demo-us', root: structuredClone(DEMO_CATEGORIES) };
    }

    try {
      const defaultTree = asRecord(
        await this.client.commerce.taxonomy.getDefaultCategoryTreeId(this.marketplaceId),
      );
      const treeId = String(defaultTree.categoryTreeId ?? '');
      if (!treeId) {
        throw new Error('eBay did not return a default category tree ID');
      }
      const tree = asRecord(
        categoryId && categoryId !== '0'
          ? await this.client.commerce.taxonomy.getCategorySubtree(treeId, categoryId)
          : await this.client.commerce.taxonomy.getCategoryTree(treeId),
      );
      const root = asRecord(tree.rootCategoryNode ?? tree.categorySubtreeNode ?? tree);
      return { treeId, root: normalizeCategory(root) };
    } catch (error) {
      const message = errorMessage(error);
      if (/not found|404/i.test(message) && categoryId) {
        throw new NotFoundError('Category', categoryId);
      }
      throw new ExternalServiceError('eBay Taxonomy API', message);
    }
  }

  async ping(): Promise<{ configured: boolean; mode: 'ebay' | 'demo' }> {
    if (this.mockEnabled || !this.client) {
      return { configured: false, mode: 'demo' };
    }

    try {
      await this.client.oAuth2.getApplicationAccessToken();
      return { configured: true, mode: 'ebay' };
    } catch (error) {
      throw new ExternalServiceError('eBay OAuth', errorMessage(error));
    }
  }
}
