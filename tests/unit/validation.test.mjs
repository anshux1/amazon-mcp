import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from '@nitrostack/core';
import { parseInput } from '../../dist/common/validation.js';
import { NormalizeInputPipe } from '../../dist/common/pipeline/normalize-input.pipe.js';
import { AddToCartSchema, UpdateCartItemSchema } from '../../dist/modules/cart/cart.tools.js';
import { OrderHistorySchema, ShippingAddressSchema } from '../../dist/modules/orders/orders.tools.js';
import { SearchProductsSchema } from '../../dist/modules/products/products.tools.js';

test('parseInput turns a Zod failure into a BAD_REQUEST with issue paths', () => {
  const schema = z.object({ name: z.string().min(2) });
  try {
    parseInput(schema, { name: 'a' });
    assert.fail('expected a validation failure');
  } catch (error) {
    assert.equal(error.code, 'BAD_REQUEST');
    assert.equal(error.statusCode, 400);
    assert.deepEqual(error.details[0].path, ['name']);
  }
});

test('add_to_cart accepts only an item id and a quantity', () => {
  const parsed = parseInput(AddToCartSchema, {
    item_id: 'v1|123|0',
    quantity: 2,
    unit_price: 0.01,
    title: 'Forged title',
    currency: 'EUR',
  });
  assert.deepEqual(parsed, { item_id: 'v1|123|0', quantity: 2 });
});

test('add_to_cart rejects out-of-range quantities', () => {
  assert.throws(() => parseInput(AddToCartSchema, { item_id: 'a', quantity: 0 }), /Input validation failed/);
  assert.throws(() => parseInput(AddToCartSchema, { item_id: 'a', quantity: 100 }), /Input validation failed/);
  assert.throws(() => parseInput(AddToCartSchema, { item_id: 'a', quantity: 1.5 }), /Input validation failed/);
  assert.throws(() => parseInput(AddToCartSchema, { item_id: '', quantity: 1 }), /Input validation failed/);
});

test('update_cart_item allows quantity 0 as a removal', () => {
  assert.deepEqual(parseInput(UpdateCartItemSchema, { item_id: 'a', quantity: 0 }), {
    item_id: 'a',
    quantity: 0,
  });
});

test('order_history applies its default limit', () => {
  assert.deepEqual(parseInput(OrderHistorySchema, {}), { limit: 20 });
  assert.throws(() => parseInput(OrderHistorySchema, { status: 'shipped' }), /Input validation failed/);
});

test('search_products applies defaults and rejects an empty query', () => {
  assert.deepEqual(parseInput(SearchProductsSchema, { query: 'lamp' }), {
    query: 'lamp',
    limit: 10,
    offset: 0,
  });
  assert.throws(() => parseInput(SearchProductsSchema, { query: '' }), /Input validation failed/);
  assert.throws(() => parseInput(SearchProductsSchema, { query: 'a', sort: 'cheapest' }), /Input validation failed/);
});

test('shipping addresses upper-case the country code', () => {
  const parsed = parseInput(ShippingAddressSchema, {
    recipient_name: 'Ada',
    line1: '1 Main St',
    city: 'London',
    postal_code: 'N1',
    country: 'gb',
  });
  assert.equal(parsed.country, 'GB');
});

test('the normalize pipe trims strings everywhere in the input', () => {
  const pipe = new NormalizeInputPipe();
  assert.deepEqual(
    pipe.transform({ query: '  lamp  ', nested: { list: ['  a  ', 2] } }, {}),
    { query: 'lamp', nested: { list: ['a', 2] } },
  );
  assert.equal(pipe.transform(5, {}), 5);
  assert.equal(pipe.transform(null, {}), null);
});
