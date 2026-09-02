import assert from 'node:assert/strict';
import test from 'node:test';
import { EbayService } from '../../dist/modules/products/ebay.service.js';
import { ProductsService } from '../../dist/modules/products/products.service.js';
import { MetricsService } from '../../dist/observability/metrics.service.js';
import { makeConfig } from '../helpers.mjs';

function liveEbay(handlers) {
  return new EbayService(makeConfig({ EBAY_RETRY_BASE_MS: '1' }), new MetricsService(), {
    buy: {
      browse: {
        search: handlers.search ?? (async () => ({ itemSummaries: [], total: 0 })),
        getItem: handlers.getItem ?? (async () => ({})),
      },
    },
    commerce: {
      taxonomy: {
        getDefaultCategoryTreeId: async () => ({ categoryTreeId: '0' }),
        getCategoryTree: async () => ({}),
        getCategorySubtree: async () => ({}),
      },
    },
    oAuth2: { getApplicationAccessToken: async () => 'token' },
  });
}

test('demo mode returns the offline catalog rather than a placeholder query', async () => {
  const ebay = new EbayService(makeConfig({ EBAY_MOCK: 'true' }), new MetricsService());
  const products = new ProductsService(ebay, makeConfig({}));

  const featured = await products.getFeatured();
  assert.equal(featured.source, 'demo');
  assert.equal(featured.strategy, 'demo_catalog');
  assert.ok(featured.items.length > 0);
  assert.deepEqual(
    featured.items.map((item) => item.itemId),
    [...featured.items.map((item) => item.itemId)].sort(),
    'the selection is deterministic',
  );
});

test('a curated item list is fetched by id and tolerates a delisted entry', async () => {
  const ebay = liveEbay({
    getItem: async (itemId) => {
      if (itemId === 'gone') {
        throw Object.assign(new Error('Item not found'), { status: 404 });
      }
      return { itemId, title: `Item ${itemId}`, price: { value: 1, currency: 'USD' } };
    },
  });
  const products = new ProductsService(ebay, makeConfig({ SHOPPING_FEATURED_ITEM_IDS: 'a, gone ,b' }));

  const featured = await products.getFeatured();
  assert.equal(featured.strategy, 'configured_items');
  assert.deepEqual(featured.items.map((item) => item.itemId), ['a', 'b']);
  assert.deepEqual(featured.unavailableItemIds, ['gone']);
});

test('without a curated list a live deployment uses a fixed catalog query', async () => {
  let received;
  const ebay = liveEbay({
    search: async (params) => {
      received = params;
      return {
        total: 2,
        itemSummaries: [
          { itemId: 'b', price: { value: 2, currency: 'USD' } },
          { itemId: 'a', price: { value: 1, currency: 'USD' } },
        ],
      };
    },
  });
  const products = new ProductsService(ebay, makeConfig({ SHOPPING_FEATURED_QUERY: 'popular gifts' }));

  const featured = await products.getFeatured();
  assert.equal(featured.strategy, 'catalog_query');
  assert.equal(featured.query, 'popular gifts');
  assert.equal(received.q, 'popular gifts');
  assert.deepEqual(featured.items.map((item) => item.itemId), ['a', 'b']);
});

test('the featured limit is bounded and defaults sensibly', async () => {
  const ebay = new EbayService(makeConfig({ EBAY_MOCK: 'true' }), new MetricsService());
  assert.equal((await new ProductsService(ebay, makeConfig({ SHOPPING_FEATURED_LIMIT: '2' })).getFeatured()).items.length, 2);
  assert.ok((await new ProductsService(ebay, makeConfig({ SHOPPING_FEATURED_LIMIT: '0' })).getFeatured()).items.length > 2);
});

test('the products facade forwards catalog reads unchanged', async () => {
  const ebay = new EbayService(makeConfig({ EBAY_MOCK: 'true' }), new MetricsService());
  const products = new ProductsService(ebay, makeConfig({}));

  const search = await products.searchItems({ query: 'headphones', limit: 5, offset: 0 });
  assert.equal(search.source, 'demo');
  const item = await products.getItem(search.items[0].itemId);
  assert.equal(item.itemId, search.items[0].itemId);
  const categories = await products.getCategories('0');
  assert.equal(categories.root.categoryId, '0');
  assert.equal(categories.truncated, false);
});
