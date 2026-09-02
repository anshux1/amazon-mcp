import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A duck-typed ConfigService.
 *
 * The real ConfigService merges process.env over its defaults, which would let
 * the developer's shell decide what a test observes. Services only ever call
 * `get(key, default)`, so a literal map keeps each test hermetic.
 */
export function makeConfig(values = {}) {
  return {
    get(key, defaultValue) {
      const value = values[key];
      return value === undefined ? defaultValue : value;
    },
    getOrThrow(key) {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing configuration: ${key}`);
      return value;
    },
    getAll() {
      return { ...values };
    },
  };
}

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function makeContext(overrides = {}) {
  return {
    requestId: 'test-request',
    toolName: 'test_tool',
    logger: silentLogger,
    metadata: {},
    ...overrides,
  };
}

/** A ProductsService stand-in whose catalog the test controls. */
export function makeProductsService(products = {}) {
  const calls = [];
  return {
    calls,
    products,
    async getItem(itemId) {
      calls.push(itemId);
      const product = products[itemId];
      if (!product) {
        const error = new Error(`Product '${itemId}' was not found`);
        error.code = 'NOT_FOUND';
        error.statusCode = 404;
        throw error;
      }
      return structuredClone(product);
    },
  };
}

export function demoProduct(overrides = {}) {
  return {
    itemId: 'item-1',
    title: 'Test Product',
    price: 10,
    currency: 'USD',
    imageUrl: 'https://i.ebayimg.com/images/g/test/s-l400.jpg',
    itemWebUrl: 'https://www.ebay.com/itm/1',
    condition: 'New',
    availableQuantity: 5,
    additionalImageUrls: [],
    buyingOptions: ['FIXED_PRICE'],
    shipping: { value: 0, currency: 'USD' },
    lastUpdated: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'amazon-mcp-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
