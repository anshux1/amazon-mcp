import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCartRevision, EMPTY_CART_REVISION } from '../../dist/common/cart-revision.js';

const item = (overrides = {}) => ({
  itemId: 'a',
  title: 'A',
  quantity: 1,
  unitPrice: 10,
  currency: 'USD',
  addedAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...overrides,
});

test('an empty cart, a null cart, and a missing cart share one revision', () => {
  assert.equal(computeCartRevision({ items: [] }), EMPTY_CART_REVISION);
  assert.equal(computeCartRevision(null), EMPTY_CART_REVISION);
  assert.equal(computeCartRevision(undefined), EMPTY_CART_REVISION);
});

test('revision is independent of item order', () => {
  const first = computeCartRevision({ items: [item({ itemId: 'a' }), item({ itemId: 'b' })] });
  const second = computeCartRevision({ items: [item({ itemId: 'b' }), item({ itemId: 'a' })] });
  assert.equal(first, second);
});

test('quantity, price, and currency changes all change the revision', () => {
  const base = computeCartRevision({ items: [item()] });
  assert.notEqual(base, computeCartRevision({ items: [item({ quantity: 2 })] }));
  assert.notEqual(base, computeCartRevision({ items: [item({ unitPrice: 11 })] }));
  assert.notEqual(base, computeCartRevision({ items: [item({ currency: 'EUR' })] }));
});

test('display-only fields do not change the revision', () => {
  const base = computeCartRevision({ items: [item()] });
  assert.equal(base, computeCartRevision({ items: [item({ title: 'Renamed', imageUrl: 'https://example.com/x.jpg' })] }));
  assert.equal(base, computeCartRevision({ items: [item({ updatedAt: '2030-01-01T00:00:00.000Z' })] }));
});
