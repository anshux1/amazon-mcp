import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigService } from '@nitrostack/core';
import { CartService } from '../../dist/modules/cart/cart.service.js';
import { DatabaseService, MIGRATIONS } from '../../dist/database/database.service.js';
import { OrdersService } from '../../dist/modules/orders/orders.service.js';
import { demoProduct, makeConfig, makeProductsService } from '../helpers.mjs';

/**
 * Postgres coverage runs only against a disposable database.
 *
 * Set TEST_DATABASE_URL to a throwaway instance; the suite truncates every
 * shopping table, so it must never point at anything that holds real data.
 */
const connectionString = process.env.TEST_DATABASE_URL;
const options = connectionString
  ? {}
  : { skip: 'set TEST_DATABASE_URL to a disposable Postgres database to run these tests' };

function postgres() {
  process.env.DATABASE_URL = connectionString;
  process.env.DATABASE_SSL = process.env.TEST_DATABASE_SSL ?? 'false';
  return new DatabaseService(new ConfigService({ ignoreEnvFile: true }));
}

function catalog() {
  return makeProductsService({
    'item-1': demoProduct({ itemId: 'item-1', price: 10, availableQuantity: 99 }),
    'item-2': demoProduct({ itemId: 'item-2', price: 5, availableQuantity: 99 }),
  });
}

test('migrations create the schema and are recorded once', options, async () => {
  const store = postgres();
  assert.equal(await store.ping(), true);
  assert.equal(store.getMode(), 'postgres');
  assert.equal(store.supportsReplicas(), true);
  assert.deepEqual(store.getAppliedMigrations(), MIGRATIONS.map((migration) => migration.version));

  // A second instance against the same database applies nothing new.
  const second = postgres();
  await second.ping();
  assert.deepEqual(second.getAppliedMigrations(), store.getAppliedMigrations());

  await store.clearForTests();
  await store.close();
  await second.close();
});

test('carts and orders are isolated per user', options, async () => {
  const store = postgres();
  await store.clearForTests();

  const carts = new CartService(store, catalog());
  await carts.addItem('u1', { item_id: 'item-1', quantity: 2 });
  await carts.addItem('u2', { item_id: 'item-2', quantity: 1 });

  assert.equal((await carts.getCart('u1')).items[0].itemId, 'item-1');
  assert.equal((await carts.getCart('u2')).items[0].itemId, 'item-2');

  const orders = new OrdersService(store, carts, catalog(), makeConfig({}));
  const quote = await orders.createCheckout('u1');
  const { order } = await orders.placeOrder('u1', quote.id);

  assert.equal(await store.getOrder('u2', order.id), null);
  assert.equal((await store.listOrders('u2')).length, 0);
  assert.equal((await carts.getCart('u2')).items.length, 1, 'placing u1 orders must not touch u2');

  await store.clearForTests();
  await store.close();
});

test('concurrent cart writes are serialized by the row lock', options, async () => {
  const store = postgres();
  await store.clearForTests();
  const carts = new CartService(store, catalog());

  await Promise.all(
    Array.from({ length: 10 }, () => carts.addItem('u1', { item_id: 'item-1', quantity: 1 })),
  );
  assert.equal((await carts.getCart('u1')).items[0].quantity, 10);

  await store.clearForTests();
  await store.close();
});

test('two service instances cannot place the same quote twice', options, async () => {
  const first = postgres();
  const second = postgres();
  await first.clearForTests();

  const cartsA = new CartService(first, catalog());
  const cartsB = new CartService(second, catalog());
  const ordersA = new OrdersService(first, cartsA, catalog(), makeConfig({}));
  const ordersB = new OrdersService(second, cartsB, catalog(), makeConfig({}));

  await cartsA.addItem('u1', { item_id: 'item-1', quantity: 1 });
  const quote = await ordersA.createCheckout('u1');

  const results = await Promise.allSettled([
    ordersA.placeOrder('u1', quote.id),
    ordersB.placeOrder('u1', quote.id),
  ]);
  const placed = results.filter((result) => result.status === 'fulfilled');
  const orderIds = new Set(placed.map((result) => result.value.order.id));
  assert.equal(orderIds.size, 1, 'both replicas must resolve to a single order');
  assert.equal((await first.listOrders('u1')).length, 1);

  await first.clearForTests();
  await first.close();
  await second.close();
});

test('the shared quota counter is atomic across instances and resets on its window', options, async () => {
  const first = postgres();
  const second = postgres();
  await first.clearForTests();

  const counts = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).incrementQuota('test-bucket', 60_000),
    ),
  );
  assert.deepEqual(
    counts.map((entry) => entry.count).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.equal((await second.readQuota('test-bucket', 60_000)).count, 20);

  // A zero-length window is already over, so the next increment starts again.
  assert.equal((await first.incrementQuota('test-bucket', 0)).count, 1);

  await first.resetQuota('test-bucket');
  assert.equal((await first.readQuota('test-bucket', 60_000)).count, 0);

  await first.clearForTests();
  await first.close();
  await second.close();
});

test('an unreachable database surfaces DATABASE_UNAVAILABLE', options, async () => {
  // Port 1 is not a Postgres listener, so this connection can only fail.
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/does-not-exist';
  process.env.DATABASE_CONNECTION_TIMEOUT_MS = '1000';
  const store = new DatabaseService(new ConfigService({ ignoreEnvFile: true }));
  assert.equal(await store.ping(), false);
  await assert.rejects(store.getCart('u1'), (error) => error.code === 'DATABASE_UNAVAILABLE');
  await store.close();
  process.env.DATABASE_URL = connectionString;
});
