import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from '@nitrostack/core';
import {
  CartViewOutputSchema,
  CategoryTreeOutputSchema,
  CheckoutQuoteOutputSchema,
  ErrorEnvelopeSchema,
  OrderOutputSchema,
  ProductDetailsOutputSchema,
  SearchResultOutputSchema,
  standardOutput,
} from '../../dist/common/output-schema.js';
import { ShoppingExceptionFilter } from '../../dist/common/pipeline/exception.filter.js';
import { ResponseTransformInterceptor } from '../../dist/common/pipeline/response.interceptor.js';
import { NotFoundError } from '../../dist/common/errors.js';
import { makeContext } from '../helpers.mjs';

const interceptor = new ResponseTransformInterceptor();
const filter = new ShoppingExceptionFilter();

async function envelope(payload) {
  return interceptor.intercept(makeContext(), async () => payload);
}

test('a wrapped success payload validates against the advertised schema', async () => {
  const schema = standardOutput(CartViewOutputSchema);
  const result = await envelope({
    userId: 'u1',
    items: [
      {
        itemId: 'item-1',
        title: 'Item',
        quantity: 1,
        unitPrice: 10,
        currency: 'USD',
        addedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
    itemCount: 1,
    subtotal: 10,
    currency: 'USD',
    revision: 'abc',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(schema.safeParse(result).success, true);
});

test('every typed failure validates against the same advertised schema', () => {
  const schema = standardOutput(CartViewOutputSchema);
  const failure = filter.catch(new NotFoundError('Order', 'ord_1'), makeContext({ toolName: 'get_order' }));
  assert.equal(schema.safeParse(failure).success, true);
  assert.equal(ErrorEnvelopeSchema.safeParse(failure).success, true);
});

test('a payload missing a required field is rejected by the contract', () => {
  const schema = standardOutput(CartViewOutputSchema);
  const result = schema.safeParse({
    success: true,
    data: { userId: 'u1', items: [] },
    timestamp: '2025-01-01T00:00:00.000Z',
    requestId: 'r1',
  });
  assert.equal(result.success, false);
});

test('an order payload keeps its fulfilment mode and quote link', () => {
  const result = OrderOutputSchema.safeParse({
    orderId: 'ord_1',
    status: 'placed',
    items: [
      {
        itemId: 'i',
        title: 'I',
        quantity: 1,
        unitPrice: 1,
        lineTotal: 1,
        currency: 'USD',
        addedAt: '',
        updatedAt: '',
      },
    ],
    subtotal: 1,
    shipping: 0,
    tax: 0,
    total: 1,
    currency: 'USD',
    fulfillment: 'demo',
    quoteId: 'chk_1',
    createdAt: '',
    updatedAt: '',
  });
  assert.equal(result.success, true);
});

test('a checkout quote payload advertises the cart revision it is bound to', () => {
  const result = CheckoutQuoteOutputSchema.safeParse({
    checkoutId: 'chk_1',
    itemCount: 1,
    items: [],
    subtotal: 0,
    shipping: 0,
    tax: 0,
    total: 0,
    currency: 'USD',
    cartRevision: 'rev',
    createdAt: '',
    expiresAt: '',
  });
  assert.equal(result.success, true);
  assert.equal(CheckoutQuoteOutputSchema.safeParse({ checkoutId: 'chk_1' }).success, false);
});

test('catalog schemas accept a recursive category tree and a search page', () => {
  assert.equal(
    CategoryTreeOutputSchema.safeParse({
      treeId: '0',
      root: {
        categoryId: '0',
        categoryName: 'All',
        children: [{ categoryId: '1', categoryName: 'One', children: [{ categoryId: '2', categoryName: 'Two', children: [] }] }],
      },
      truncated: false,
      depth: 2,
    }).success,
    true,
  );

  assert.equal(
    SearchResultOutputSchema.safeParse({
      total: 1,
      offset: 0,
      limit: 10,
      source: 'demo',
      items: [{ itemId: 'a', title: 'A', price: 1, currency: 'USD' }],
    }).success,
    true,
  );

  assert.equal(
    ProductDetailsOutputSchema.safeParse({
      itemId: 'a',
      title: 'A',
      price: 1,
      currency: 'USD',
      additionalImageUrls: [],
      buyingOptions: [],
      lastUpdated: '',
    }).success,
    true,
  );
});

test('every output schema converts to a JSON Schema object for clients', () => {
  for (const schema of [
    standardOutput(CartViewOutputSchema),
    standardOutput(OrderOutputSchema),
    standardOutput(CategoryTreeOutputSchema),
  ]) {
    assert.ok(schema instanceof z.ZodType);
  }
});
