import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGetCategoriesCacheKey,
  buildGetProductCacheKey,
  buildSearchProductsCacheKey,
} from '../../dist/modules/products/products.tools.js';

test('search cache keys ignore request metadata such as a bearer token', () => {
  const withMeta = buildSearchProductsCacheKey({
    query: 'lamp',
    limit: 5,
    _meta: { authorization: 'Bearer super-secret-token' },
  });
  const withoutMeta = buildSearchProductsCacheKey({ query: 'lamp', limit: 5 });
  assert.equal(withMeta, withoutMeta);
  assert.ok(!withMeta.includes('super-secret-token'));
});

test('search cache keys normalize case and surrounding whitespace', () => {
  assert.equal(
    buildSearchProductsCacheKey({ query: '  Wireless Headphones ' }),
    buildSearchProductsCacheKey({ query: 'wireless headphones' }),
  );
});

test('search cache keys separate different parameters', () => {
  const base = buildSearchProductsCacheKey({ query: 'lamp' });
  assert.notEqual(base, buildSearchProductsCacheKey({ query: 'lamp', limit: 25 }));
  assert.notEqual(base, buildSearchProductsCacheKey({ query: 'lamp', offset: 10 }));
  assert.notEqual(base, buildSearchProductsCacheKey({ query: 'lamp', category_id: '293' }));
  assert.notEqual(base, buildSearchProductsCacheKey({ query: 'lamp', sort: 'price' }));
});

test('an unsupported sort value is dropped rather than cached separately', () => {
  assert.equal(
    buildSearchProductsCacheKey({ query: 'lamp', sort: 'cheapest' }),
    buildSearchProductsCacheKey({ query: 'lamp' }),
  );
});

test('item and category cache keys are namespaced and trimmed', () => {
  assert.equal(buildGetProductCacheKey({ item_id: ' v1|1|0 ' }), 'ebay:item:v1|1|0');
  assert.equal(buildGetProductCacheKey({}), 'ebay:item:');
  assert.equal(buildGetCategoriesCacheKey({}), 'ebay:categories:0');
  assert.equal(buildGetCategoriesCacheKey({ category_id: ' 293 ' }), 'ebay:categories:293');
});
