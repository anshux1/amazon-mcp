import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigService } from '@nitrostack/core';
import { CartService } from '../../dist/modules/cart/cart.service.js';
import { DatabaseService } from '../../dist/database/database.service.js';
import { OrdersService } from '../../dist/modules/orders/orders.service.js';
import { demoProduct, makeConfig, makeProductsService } from '../helpers.mjs';

function memoryDatabase() {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.DATABASE_FILE = ':memory:';
  const database = new DatabaseService(new ConfigService({ ignoreEnvFile: true }));
  if (previous !== undefined) process.env.DATABASE_URL = previous;
  return database;
}

function setup(products, config = {}) {
  const database = memoryDatabase();
  const catalog = makeProductsService(products);
  const cart = new CartService(database, catalog);
  const orders = new OrdersService(database, cart, catalog, makeConfig(config));
  return { database, catalog, cart, orders };
}

const twoItems = () => ({
  'item-1': demoProduct({ itemId: 'item-1', price: 10, availableQuantity: 20, shipping: { value: 2, currency: 'USD' } }),
  'item-2': demoProduct({ itemId: 'item-2', price: 5.5, availableQuantity: 20, shipping: { value: 0, currency: 'USD' } }),
});

test('a quote totals items, per-unit shipping, and tax', async () => {
  const { cart, orders } = setup(twoItems(), { SHOPPING_TAX_RATE: '0.1' });
  await cart.addItem('u1', { item_id: 'item-1', quantity: 2 });
  await cart.addItem('u1', { item_id: 'item-2', quantity: 1 });

  const quote = await orders.createCheckout('u1');
  assert.equal(quote.subtotal, 25.5);
  assert.equal(quote.shipping, 4);
  assert.equal(quote.tax, 2.55);
  assert.equal(quote.total, 32.05);
  assert.equal(quote.currency, 'USD');
  assert.equal(quote.status, 'active');
  assert.ok(quote.cartRevision);
  assert.ok(Date.parse(quote.expiresAt) > Date.parse(quote.createdAt));
});

test('the quote lifetime honours SHOPPING_QUOTE_TTL_SECONDS', async () => {
  const { cart, orders } = setup(twoItems(), { SHOPPING_QUOTE_TTL_SECONDS: '60' });
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const quote = await orders.createCheckout('u1');
  assert.equal(Date.parse(quote.expiresAt) - Date.parse(quote.createdAt), 60_000);
});

test('checking out an empty cart is a BAD_REQUEST', async () => {
  const { orders } = setup(twoItems());
  await assert.rejects(orders.createCheckout('u1'), (error) => error.code === 'BAD_REQUEST');
});

test('a quote refuses stock that disappeared since the item was added', async () => {
  const { cart, catalog, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 5 });
  catalog.products['item-1'] = demoProduct({ itemId: 'item-1', price: 10, availableQuantity: 1 });
  await assert.rejects(orders.createCheckout('u1'), (error) => error.code === 'OUT_OF_STOCK');
});

test('placing an order consumes the quote, stores the order, and clears the cart', async () => {
  const { cart, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 2 });
  const quote = await orders.createCheckout('u1');

  const { order, alreadyPlaced } = await orders.placeOrder('u1', quote.id);
  assert.equal(alreadyPlaced, false);
  assert.equal(order.status, 'placed');
  assert.equal(order.quoteId, quote.id);
  assert.equal(order.fulfillment, 'demo');
  assert.equal(order.total, quote.total);
  assert.deepEqual((await cart.getCart('u1')).items, []);
  assert.equal((await orders.getOrder('u1', order.id)).id, order.id);
});

test('retrying place_order with the same checkout returns the same order', async () => {
  const { cart, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const quote = await orders.createCheckout('u1');

  const first = await orders.placeOrder('u1', quote.id);
  const second = await orders.placeOrder('u1', quote.id);
  assert.equal(second.alreadyPlaced, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal((await orders.getOrderHistory('u1')).length, 1);
});

test('two concurrent placements of one quote produce exactly one order', async () => {
  const { cart, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const quote = await orders.createCheckout('u1');

  const results = await Promise.all([orders.placeOrder('u1', quote.id), orders.placeOrder('u1', quote.id)]);
  const orderIds = new Set(results.map((result) => result.order.id));
  assert.equal(orderIds.size, 1);
  assert.equal((await orders.getOrderHistory('u1')).length, 1);
});

test('a quote belonging to another user is never visible', async () => {
  const { cart, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const quote = await orders.createCheckout('u1');
  await assert.rejects(orders.placeOrder('u2', quote.id), (error) => error.code === 'NOT_FOUND');
});

test('an expired quote cannot be placed and is pruned', async () => {
  const { cart, database, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const quote = await orders.createCheckout('u1');

  await database.saveQuote({ ...quote, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(orders.placeOrder('u1', quote.id), (error) => error.code === 'CONFLICT');

  assert.equal(await orders.pruneExpiredQuotes(), 1);
  assert.equal(await database.getQuote('u1', quote.id), null);
});

test('a cart changed after checkout blocks the stale quote and keeps the new cart', async () => {
  const { cart, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const stale = await orders.createCheckout('u1');

  await cart.addItem('u1', { item_id: 'item-2', quantity: 1 });

  await assert.rejects(orders.placeOrder('u1', stale.id), (error) => {
    assert.equal(error.code, 'CONFLICT');
    assert.equal(error.details.quotedCartRevision, stale.cartRevision);
    assert.notEqual(error.details.currentCartRevision, stale.cartRevision);
    return true;
  });

  const preserved = await cart.getCart('u1');
  assert.equal(preserved.items.length, 2, 'the newer cart must survive a stale placement attempt');
});

test('a newer quote taken after the change still places', async () => {
  const { cart, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const stale = await orders.createCheckout('u1');
  await cart.addItem('u1', { item_id: 'item-2', quantity: 1 });
  const fresh = await orders.createCheckout('u1');

  const { order } = await orders.placeOrder('u1', fresh.id);
  assert.equal(order.items.length, 2);
  await assert.rejects(orders.placeOrder('u1', stale.id), (error) => error.code === 'NOT_FOUND' || error.code === 'CONFLICT');
});

test('a price change between checkout and placement is a conflict, not a silent charge', async () => {
  const { cart, catalog, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const quote = await orders.createCheckout('u1');

  catalog.products['item-1'] = demoProduct({ itemId: 'item-1', price: 99, availableQuantity: 20 });
  await assert.rejects(orders.placeOrder('u1', quote.id), (error) => {
    assert.equal(error.code, 'CONFLICT');
    assert.equal(error.details.changes[0].quotedPrice, 10);
    assert.equal(error.details.changes[0].currentPrice, 99);
    return true;
  });
  assert.equal((await orders.getOrderHistory('u1')).length, 0);
});

test('stock lost between checkout and placement is reported as out of stock', async () => {
  const { cart, catalog, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 4 });
  const quote = await orders.createCheckout('u1');

  catalog.products['item-1'] = demoProduct({ itemId: 'item-1', price: 10, availableQuantity: 1 });
  await assert.rejects(orders.placeOrder('u1', quote.id), (error) => error.code === 'OUT_OF_STOCK');
});

test('order history filters by status and honours its limit', async () => {
  const { cart, orders } = setup(twoItems());
  for (let index = 0; index < 3; index += 1) {
    await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
    const quote = await orders.createCheckout('u1');
    await orders.placeOrder('u1', quote.id);
  }

  const all = await orders.getOrderHistory('u1');
  assert.equal(all.length, 3);
  assert.equal((await orders.getOrderHistory('u1', undefined, 2)).length, 2);

  await orders.cancelOrder('u1', all[0].id);
  assert.equal((await orders.getOrderHistory('u1', 'cancelled')).length, 1);
  assert.equal((await orders.getOrderHistory('u1', 'placed')).length, 2);
  assert.equal((await orders.getOrderHistory('u2')).length, 0);
});

test('cancelling twice is a conflict and another user cannot cancel', async () => {
  const { cart, orders } = setup(twoItems());
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const quote = await orders.createCheckout('u1');
  const { order } = await orders.placeOrder('u1', quote.id);

  const cancelled = await orders.cancelOrder('u1', order.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.cancelledAt);
  await assert.rejects(orders.cancelOrder('u1', order.id), (error) => error.code === 'CONFLICT');
  await assert.rejects(orders.cancelOrder('u2', order.id), (error) => error.code === 'NOT_FOUND');
});

test('a missing order or checkout is a NOT_FOUND', async () => {
  const { orders } = setup(twoItems());
  await assert.rejects(orders.getOrder('u1', 'ord_missing'), (error) => error.code === 'NOT_FOUND');
  await assert.rejects(orders.placeOrder('u1', 'chk_missing'), (error) => error.code === 'NOT_FOUND');
});

test('mixed currencies cannot be quoted', async () => {
  const { database, cart, orders } = setup({
    usd: demoProduct({ itemId: 'usd', currency: 'USD', price: 5, availableQuantity: 9 }),
    eur: demoProduct({ itemId: 'eur', currency: 'EUR', price: 5, availableQuantity: 9 }),
  });
  // The cart guard normally prevents this; write the mixed cart directly so the
  // checkout guard is exercised on its own.
  await database.saveCart({
    userId: 'u1',
    updatedAt: new Date().toISOString(),
    items: [
      { itemId: 'usd', title: 'USD', quantity: 1, unitPrice: 5, currency: 'USD', addedAt: '', updatedAt: '' },
      { itemId: 'eur', title: 'EUR', quantity: 1, unitPrice: 5, currency: 'EUR', addedAt: '', updatedAt: '' },
    ],
  });
  await assert.rejects(orders.createCheckout('u1'), (error) => error.code === 'CONFLICT');
  assert.equal((await cart.getCart('u1')).items.length, 2);
});

test('the fulfilment mode is demo unless it is explicitly changed', () => {
  assert.equal(setup({}).orders.getFulfillmentMode(), 'demo');
  assert.equal(setup({}, { SHOPPING_FULFILLMENT_MODE: 'external' }).orders.getFulfillmentMode(), 'external');
});
