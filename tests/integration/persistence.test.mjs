import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigService } from '@nitrostack/core';
import { CartService } from '../../dist/modules/cart/cart.service.js';
import { DatabaseService } from '../../dist/database/database.service.js';
import { OrdersService } from '../../dist/modules/orders/orders.service.js';
import { computeCartRevision } from '../../dist/common/cart-revision.js';
import { demoProduct, makeConfig, makeProductsService, withTempDirectory } from '../helpers.mjs';

function database(databaseFile) {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.DATABASE_FILE = databaseFile;
  const service = new DatabaseService(new ConfigService({ ignoreEnvFile: true }));
  if (previous !== undefined) process.env.DATABASE_URL = previous;
  return service;
}

const cart = (userId, items) => ({ userId, items, updatedAt: new Date().toISOString() });
const item = (itemId, quantity = 1) => ({
  itemId,
  title: itemId,
  quantity,
  unitPrice: 10,
  currency: 'USD',
  addedAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
});

const order = (id, userId, overrides = {}) => ({
  id,
  userId,
  status: 'placed',
  items: [{ ...item('item-1'), unitPrice: 10, lineTotal: 10 }],
  subtotal: 10,
  shipping: 0,
  tax: 0,
  total: 10,
  currency: 'USD',
  fulfillment: 'demo',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

test('the memory adapter isolates users and reports its mode', async () => {
  const store = database(':memory:');
  assert.equal(store.getMode(), 'memory');
  assert.equal(store.supportsReplicas(), false);
  assert.equal(await store.ping(), true);

  await store.saveCart(cart('u1', [item('item-1', 2)]));
  await store.saveCart(cart('u2', [item('item-2', 1)]));
  assert.equal((await store.getCart('u1')).items[0].quantity, 2);
  assert.equal((await store.getCart('u2')).items[0].itemId, 'item-2');
  assert.equal(await store.getCart('u3'), null);

  await store.saveOrder(order('ord_1', 'u1'));
  assert.equal((await store.getOrder('u1', 'ord_1')).id, 'ord_1');
  assert.equal(await store.getOrder('u2', 'ord_1'), null, 'orders are scoped to their owner');
  assert.equal((await store.listOrders('u2')).length, 0);

  await store.clearForTests();
  assert.equal(await store.getCart('u1'), null);
  await store.close();
});

test('a returned record is a copy, so a caller cannot mutate stored state', async () => {
  const store = database(':memory:');
  await store.saveCart(cart('u1', [item('item-1', 1)]));
  const first = await store.getCart('u1');
  first.items[0].quantity = 99;
  assert.equal((await store.getCart('u1')).items[0].quantity, 1);
  await store.close();
});

test('the file adapter survives a process restart', async () => {
  await withTempDirectory(async (directory) => {
    const file = join(directory, 'shopping-db.json');

    const first = database(file);
    await first.saveCart(cart('u1', [item('item-1', 3)]));
    await first.saveOrder(order('ord_1', 'u1'));
    await first.saveQuote({
      id: 'chk_1',
      userId: 'u1',
      status: 'active',
      items: [],
      subtotal: 0,
      shipping: 0,
      tax: 0,
      total: 0,
      currency: 'USD',
      cartRevision: 'rev',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await first.close();

    const restarted = database(file);
    assert.equal(restarted.getMode(), 'file');
    assert.equal((await restarted.getCart('u1')).items[0].quantity, 3);
    assert.equal((await restarted.getOrder('u1', 'ord_1')).id, 'ord_1');
    assert.equal((await restarted.getQuote('u1', 'chk_1')).status, 'active');
    await restarted.close();

    const document = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(document.version, 2);
  });
});

test('an older on-disk document is upgraded in place', async () => {
  await withTempDirectory(async (directory) => {
    const file = join(directory, 'legacy.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        carts: { u1: cart('u1', [item('item-1')]) },
        orders: { ord_1: { ...order('ord_1', 'u1'), fulfillment: undefined } },
      }),
      'utf8',
    );

    const store = database(file);
    const migrated = await store.getOrder('u1', 'ord_1');
    assert.equal(migrated.fulfillment, 'demo');
    assert.equal((await store.getCart('u1')).items.length, 1);
    assert.deepEqual(await store.listQuotes('u1'), []);
    await store.close();
  });
});

test('an unreadable database document leaves the service unavailable rather than empty', async () => {
  await withTempDirectory(async (directory) => {
    const file = join(directory, 'broken.json');
    await writeFile(file, '{"version": 99}', 'utf8');

    const store = database(file);
    assert.equal(await store.ping(), false);
    assert.ok(store.getInitializationError());
    await assert.rejects(store.getCart('u1'), (error) => error.code === 'DATABASE_UNAVAILABLE');
    await store.close();
  });
});

test('concurrent cart mutations never lose an update', async () => {
  const store = database(':memory:');
  const catalog = makeProductsService({
    'item-1': demoProduct({ itemId: 'item-1', availableQuantity: 99 }),
    'item-2': demoProduct({ itemId: 'item-2', availableQuantity: 99 }),
  });
  const carts = new CartService(store, catalog);

  await Promise.all([
    carts.addItem('u1', { item_id: 'item-1', quantity: 1 }),
    carts.addItem('u1', { item_id: 'item-2', quantity: 1 }),
    carts.addItem('u1', { item_id: 'item-1', quantity: 1 }),
  ]);

  const result = await carts.getCart('u1');
  const quantities = Object.fromEntries(result.items.map((entry) => [entry.itemId, entry.quantity]));
  assert.deepEqual(quantities, { 'item-1': 2, 'item-2': 1 });
  await store.close();
});

test('concurrent quantity updates converge without dropping a write', async () => {
  const store = database(':memory:');
  const catalog = makeProductsService({ 'item-1': demoProduct({ itemId: 'item-1', availableQuantity: 99 }) });
  const carts = new CartService(store, catalog);
  await carts.addItem('u1', { item_id: 'item-1', quantity: 1 });

  await Promise.all([
    carts.updateItem('u1', 'item-1', 5),
    carts.updateItem('u1', 'item-1', 7),
    carts.addItem('u1', { item_id: 'item-1', quantity: 1 }),
  ]);

  const result = await carts.getCart('u1');
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0].quantity >= 1);
  await store.close();
});

test('placing an order is atomic with clearing the cart', async () => {
  const store = database(':memory:');
  const catalog = makeProductsService({ 'item-1': demoProduct({ itemId: 'item-1', availableQuantity: 99 }) });
  const carts = new CartService(store, catalog);
  const orders = new OrdersService(store, carts, catalog, makeConfig({}));

  await carts.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const quote = await orders.createCheckout('u1');
  const { order: placed } = await orders.placeOrder('u1', quote.id);

  assert.equal((await store.getCart('u1')), null);
  assert.equal((await store.getOrder('u1', placed.id)).id, placed.id);
  assert.equal((await store.getQuote('u1', quote.id)).status, 'consumed');
  await store.close();
});

test('a stale quote is refused by the storage layer itself', async () => {
  const store = database(':memory:');
  await store.saveCart(cart('u1', [item('item-1', 1)]));
  const currentRevision = computeCartRevision(await store.getCart('u1'));
  await store.saveQuote({
    id: 'chk_1',
    userId: 'u1',
    status: 'active',
    items: [],
    subtotal: 0,
    shipping: 0,
    tax: 0,
    total: 0,
    currency: 'USD',
    cartRevision: 'a-different-revision',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const result = await store.placeOrderFromQuote({
    quoteId: 'chk_1',
    userId: 'u1',
    order: order('ord_1', 'u1', { quoteId: 'chk_1' }),
    expectedCartRevision: 'a-different-revision',
  });

  assert.equal(result.outcome, 'cart_changed');
  assert.equal(result.currentRevision, currentRevision);
  assert.equal(await store.getOrder('u1', 'ord_1'), null);
  assert.equal((await store.getCart('u1')).items.length, 1);
  await store.close();
});

test('expired active quotes are pruned while consumed ones are retained', async () => {
  const store = database(':memory:');
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const base = {
    userId: 'u1',
    items: [],
    subtotal: 0,
    shipping: 0,
    tax: 0,
    total: 0,
    currency: 'USD',
    cartRevision: 'rev',
    createdAt: expiredAt,
    expiresAt: expiredAt,
  };
  await store.saveQuote({ ...base, id: 'chk_active', status: 'active' });
  await store.saveQuote({ ...base, id: 'chk_consumed', status: 'consumed', placedOrderId: 'ord_1' });

  assert.equal(await store.deleteExpiredQuotes(), 1);
  assert.equal(await store.getQuote('u1', 'chk_active'), null);
  assert.ok(await store.getQuote('u1', 'chk_consumed'), 'a consumed quote stays available for retries');

  // Past the retention window the consumed quote is collected too.
  assert.equal(await store.deleteExpiredQuotes(new Date(), 0), 1);
  assert.equal(await store.getQuote('u1', 'chk_consumed'), null);
  await store.close();
});
