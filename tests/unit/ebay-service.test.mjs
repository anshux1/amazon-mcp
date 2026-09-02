import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundCategoryTree,
  categorizeEbayError,
  EbayService,
  sanitizeUpstreamMessage,
} from '../../dist/modules/products/ebay.service.js';
import { MetricsService } from '../../dist/observability/metrics.service.js';
import { makeConfig } from '../helpers.mjs';

const liveConfig = (extra = {}) => makeConfig({ EBAY_RETRY_BASE_MS: '1', ...extra });

function makeClient(handlers = {}) {
  return {
    buy: {
      browse: {
        search: handlers.search ?? (async () => ({ itemSummaries: [], total: 0 })),
        getItem: handlers.getItem ?? (async () => ({})),
      },
    },
    commerce: {
      taxonomy: {
        getDefaultCategoryTreeId: handlers.getDefaultCategoryTreeId ?? (async () => ({ categoryTreeId: '0' })),
        getCategoryTree: handlers.getCategoryTree ?? (async () => ({})),
        getCategorySubtree: handlers.getCategorySubtree ?? (async () => ({})),
      },
    },
    oAuth2: { getApplicationAccessToken: handlers.getApplicationAccessToken ?? (async () => 'token') },
  };
}

test('a Browse item is normalized into the shared product shape', async () => {
  const service = new EbayService(
    liveConfig(),
    new MetricsService(),
    makeClient({
      getItem: async () => ({
        itemId: 'v1|123|0',
        title: 'Wireless Headphones',
        price: { value: '79.99', currency: 'USD' },
        image: { imageUrl: 'https://i.ebayimg.com/a.jpg' },
        additionalImages: [{ imageUrl: 'https://i.ebayimg.com/b.jpg' }, { nope: true }],
        itemWebUrl: 'https://www.ebay.com/itm/123',
        condition: 'New',
        categories: [{ categoryId: '293' }],
        seller: { username: 'seller', feedbackPercentage: '99.4' },
        estimatedAvailabilities: [{ estimatedAvailableQuantity: 4 }],
        shippingOptions: [{ shippingCost: { value: '4.99', currency: 'USD' } }],
        itemLocation: { city: 'Austin' },
        buyingOptions: ['FIXED_PRICE', 7],
        shortDescription: 'Nice headphones',
      }),
    }),
  );

  const item = await service.getItem('v1|123|0');
  assert.equal(item.itemId, 'v1|123|0');
  assert.equal(item.price, 79.99);
  assert.equal(item.currency, 'USD');
  assert.equal(item.categoryId, '293');
  assert.equal(item.availableQuantity, 4);
  assert.deepEqual(item.seller, { username: 'seller', feedbackPercentage: 99.4 });
  assert.deepEqual(item.shipping, { value: 4.99, currency: 'USD' });
  assert.deepEqual(item.additionalImageUrls, ['https://i.ebayimg.com/b.jpg']);
  assert.deepEqual(item.buyingOptions, ['FIXED_PRICE']);
  assert.equal(item.location, 'Austin');
});

test('a sparse Browse item still normalizes to safe defaults', async () => {
  const service = new EbayService(
    liveConfig(),
    new MetricsService(),
    makeClient({ getItem: async () => ({ itemId: 'v1|1|0' }) }),
  );
  const item = await service.getItem('v1|1|0');
  assert.equal(item.title, 'Untitled eBay item');
  assert.equal(item.price, 0);
  assert.equal(item.currency, 'USD');
  assert.equal(item.availableQuantity, null);
  assert.equal(item.seller, undefined);
  assert.deepEqual(item.additionalImageUrls, []);
});

test('an item response without an item id is a NOT_FOUND, not an empty product', async () => {
  const service = new EbayService(
    liveConfig(),
    new MetricsService(),
    makeClient({ getItem: async () => ({}) }),
  );
  await assert.rejects(service.getItem('missing'), (error) => error.code === 'NOT_FOUND');
});

test('search maps parameters and normalizes every summary', async () => {
  let received;
  const service = new EbayService(
    liveConfig(),
    new MetricsService(),
    makeClient({
      search: async (params) => {
        received = params;
        return { total: 2, itemSummaries: [{ itemId: 'a', price: { value: 1, currency: 'EUR' } }] };
      },
    }),
  );

  const result = await service.searchItems({ query: 'lamp', categoryId: '293', limit: 5, offset: 10, sort: 'price' });
  assert.deepEqual(received, { q: 'lamp', limit: '5', offset: '10', category_ids: '293', sort: 'price' });
  assert.equal(result.source, 'ebay');
  assert.equal(result.total, 2);
  assert.equal(result.items[0].currency, 'EUR');
});

test('a 404 from Browse becomes NOT_FOUND and other failures become EXTERNAL_SERVICE_ERROR', async () => {
  const notFound = new EbayService(
    liveConfig(),
    new MetricsService(),
    makeClient({
      getItem: async () => {
        throw Object.assign(new Error('Item not found'), { status: 404 });
      },
    }),
  );
  await assert.rejects(notFound.getItem('x'), (error) => error.code === 'NOT_FOUND');

  const badCredentials = new EbayService(
    liveConfig(),
    new MetricsService(),
    makeClient({
      search: async () => {
        throw Object.assign(new Error('invalid_client'), { status: 401 });
      },
    }),
  );
  await assert.rejects(
    badCredentials.searchItems({ query: 'a', limit: 1, offset: 0 }),
    (error) => error.code === 'EXTERNAL_SERVICE_ERROR' && error.statusCode === 502,
  );
});

test('transient failures are retried and permanent ones are not', async () => {
  let attempts = 0;
  const flaky = new EbayService(
    liveConfig({ EBAY_MAX_RETRIES: '2' }),
    new MetricsService(),
    makeClient({
      search: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('gateway'), { status: 503 });
        return { total: 0, itemSummaries: [] };
      },
    }),
  );
  await flaky.searchItems({ query: 'a', limit: 1, offset: 0 });
  assert.equal(attempts, 3);

  let permanentAttempts = 0;
  const permanent = new EbayService(
    liveConfig({ EBAY_MAX_RETRIES: '2' }),
    new MetricsService(),
    makeClient({
      search: async () => {
        permanentAttempts += 1;
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
    }),
  );
  await assert.rejects(permanent.searchItems({ query: 'a', limit: 1, offset: 0 }));
  assert.equal(permanentAttempts, 1);
});

test('retries stop at the configured bound', async () => {
  let attempts = 0;
  const service = new EbayService(
    liveConfig({ EBAY_MAX_RETRIES: '1' }),
    new MetricsService(),
    makeClient({
      search: async () => {
        attempts += 1;
        throw new Error('socket hang up');
      },
    }),
  );
  await assert.rejects(service.searchItems({ query: 'a', limit: 1, offset: 0 }));
  assert.equal(attempts, 2);
});

test('upstream failures never carry credentials into tool output', async () => {
  const service = new EbayService(
    liveConfig({ EBAY_MAX_RETRIES: '0' }),
    new MetricsService(),
    makeClient({
      search: async () => {
        throw new Error(
          'Request failed: authorization: Bearer v^1.1#i^1#SECRETTOKEN, client_secret=PRD-abc123 appId=MyApp-PRD-1234',
        );
      },
    }),
  );

  await assert.rejects(service.searchItems({ query: 'a', limit: 1, offset: 0 }), (error) => {
    assert.ok(!/SECRETTOKEN/.test(error.message), error.message);
    assert.ok(!/PRD-abc123/.test(error.message), error.message);
    assert.ok(!/MyApp-PRD-1234/.test(error.message), error.message);
    assert.match(error.message, /redacted/);
    return true;
  });
});

test('sanitizeUpstreamMessage redacts credential-shaped fragments', () => {
  assert.equal(sanitizeUpstreamMessage('Authorization: Bearer abc.def'), 'Authorization: [redacted]');
  assert.equal(sanitizeUpstreamMessage('sent Bearer abc.def upstream'), 'sent Bearer [redacted] upstream');
  assert.match(sanitizeUpstreamMessage('access_token=abc123&x=1'), /access_token=\[redacted\]/);
  assert.match(sanitizeUpstreamMessage('"client_secret": "abc"'), /redacted/);
  assert.equal(sanitizeUpstreamMessage('x'.repeat(1000)).length, 300);
});

test('error categories drive both retries and metrics', () => {
  assert.equal(categorizeEbayError(Object.assign(new Error('x'), { status: 404 })), 'not_found');
  assert.equal(categorizeEbayError(Object.assign(new Error('x'), { status: 401 })), 'unauthorized');
  assert.equal(categorizeEbayError(Object.assign(new Error('x'), { status: 429 })), 'rate_limited');
  assert.equal(categorizeEbayError(Object.assign(new Error('x'), { status: 502 })), 'server_error');
  assert.equal(categorizeEbayError(new Error('request timed out')), 'timeout');
  assert.equal(categorizeEbayError(new Error('ECONNRESET')), 'network');
  assert.equal(categorizeEbayError(new Error('something else')), 'unknown');
  assert.equal(categorizeEbayError({ response: { status: 503 } }), 'server_error');
});

test('the demo catalog answers search, item, and category lookups offline', async () => {
  const service = new EbayService(makeConfig({ EBAY_MOCK: 'true' }), new MetricsService());
  assert.equal(service.isMockEnabled(), true);
  assert.equal(service.isConfigured(), false);

  const search = await service.searchItems({ query: 'headphones', limit: 10, offset: 0 });
  assert.equal(search.source, 'demo');
  assert.ok(search.items.length >= 1);

  const item = await service.getItem(search.items[0].itemId);
  assert.equal(item.itemId, search.items[0].itemId);
  await assert.rejects(service.getItem('nope'), (error) => error.code === 'NOT_FOUND');

  const tree = await service.getCategoryTree('0');
  assert.equal(tree.root.categoryId, '0');
  await assert.rejects(service.getCategoryTree('does-not-exist'), (error) => error.code === 'NOT_FOUND');

  assert.deepEqual(await service.ping(), { configured: false, mode: 'demo', sandbox: false });
});

test('live credentials are required when the demo catalog is not requested', () => {
  assert.throws(
    () => new EbayService(makeConfig({ NODE_ENV: 'production', EBAY_MOCK: 'false' }), new MetricsService()),
    /credentials are required/,
  );
});

test('a category tree is bounded by depth and node count', () => {
  const deep = (depth) => ({
    categoryId: `c${depth}`,
    categoryName: `Level ${depth}`,
    children: depth === 0 ? [] : [deep(depth - 1)],
  });

  const bounded = boundCategoryTree(deep(8), 3, 1000);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.depth, 3);

  const wide = {
    categoryId: 'root',
    categoryName: 'Root',
    children: Array.from({ length: 50 }, (_, index) => ({
      categoryId: `w${index}`,
      categoryName: `W${index}`,
      children: [],
    })),
  };
  const limited = boundCategoryTree(wide, 5, 10);
  assert.equal(limited.truncated, true);
  assert.ok(limited.root.children.length < 50);

  const small = boundCategoryTree({ categoryId: '0', categoryName: 'All', children: [] }, 4, 100);
  assert.equal(small.truncated, false);
  assert.equal(small.depth, 0);
});
