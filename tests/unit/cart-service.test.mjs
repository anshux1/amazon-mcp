import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigService } from '@nitrostack/core';
import { CartService, MAX_CART_ITEMS } from '../../dist/modules/cart/cart.service.js';
import { DatabaseService } from '../../dist/database/database.service.js';
import { computeCartRevision } from '../../dist/common/cart-revision.js';
import { demoProduct, makeProductsService } from '../helpers.mjs';

function memoryDatabase() {
  // ConfigService merges process.env last, so a DATABASE_URL in the developer's
  // shell would otherwise silently switch the adapter under the test.
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.DATABASE_FILE = ':memory:';
  const database = new DatabaseService(new ConfigService({ ignoreEnvFile: true }));
  if (previous !== undefined) process.env.DATABASE_URL = previous;
  return database;
}

function setup(products) {
  const catalog = makeProductsService(products);
  return { catalog, cart: new CartService(memoryDatabase(), catalog) };
}

test('an added item takes its title, price, and currency from the catalog', async () => {
  const { cart } = setup({
    'item-1': demoProduct({ title: 'Server Title', price: 79.99, currency: 'USD' }),
  });

  const saved = await cart.addItem('u1', { item_id: 'item-1', quantity: 2 });
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].title, 'Server Title');
  assert.equal(saved.items[0].unitPrice, 79.99);
  assert.equal(saved.items[0].currency, 'USD');

  const view = cart.toView(saved);
  assert.equal(view.itemCount, 2);
  assert.equal(view.subtotal, 159.98);
  assert.equal(view.revision, computeCartRevision(saved));
});

test('a forged price, title, or currency in the input is ignored', async () => {
  const { cart } = setup({ 'item-1': demoProduct({ price: 79.99, currency: 'USD', title: 'Real' }) });
  const saved = await cart.addItem('u1', {
    item_id: 'item-1',
    quantity: 1,
    unit_price: 0.01,
    title: 'Forged',
    currency: 'JPY',
  });
  assert.equal(saved.items[0].unitPrice, 79.99);
  assert.equal(saved.items[0].title, 'Real');
  assert.equal(saved.items[0].currency, 'USD');
});

test('a nonexistent item is rejected before it reaches the cart', async () => {
  const { cart } = setup({});
  await assert.rejects(cart.addItem('u1', { item_id: 'nope', quantity: 1 }), /not found/i);
  assert.deepEqual((await cart.getCart('u1')).items, []);
});

test('adding the same item accumulates quantity and re-reads its price', async () => {
  const catalog = makeProductsService({ 'item-1': demoProduct({ price: 10, availableQuantity: 99 }) });
  const cart = new CartService(memoryDatabase(), catalog);

  await cart.addItem('u1', { item_id: 'item-1', quantity: 2 });
  catalog.products['item-1'] = demoProduct({ price: 12, availableQuantity: 99 });
  const saved = await cart.addItem('u1', { item_id: 'item-1', quantity: 3 });

  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].quantity, 5);
  assert.equal(saved.items[0].unitPrice, 12);
  assert.equal(cart.toView(saved).subtotal, 60);
});

test('the per-item quantity ceiling counts what is already in the cart', async () => {
  const { cart } = setup({ 'item-1': demoProduct({ availableQuantity: null }) });
  await cart.addItem('u1', { item_id: 'item-1', quantity: 90 });
  await assert.rejects(
    cart.addItem('u1', { item_id: 'item-1', quantity: 10 }),
    (error) => error.code === 'BAD_REQUEST',
  );
});

test('adding more units than are available is out of stock', async () => {
  const { cart } = setup({ 'item-1': demoProduct({ availableQuantity: 3 }) });
  await assert.rejects(
    cart.addItem('u1', { item_id: 'item-1', quantity: 4 }),
    (error) => error.code === 'OUT_OF_STOCK' && error.details.available === 3,
  );

  await cart.addItem('u1', { item_id: 'item-1', quantity: 3 });
  await assert.rejects(
    cart.addItem('u1', { item_id: 'item-1', quantity: 1 }),
    (error) => error.code === 'OUT_OF_STOCK',
  );
});

test('an item with unknown availability may still be added', async () => {
  const { cart } = setup({ 'item-1': demoProduct({ availableQuantity: null }) });
  const saved = await cart.addItem('u1', { item_id: 'item-1', quantity: 7 });
  assert.equal(saved.items[0].quantity, 7);
});

test('a cart cannot mix currencies', async () => {
  const { cart } = setup({
    usd: demoProduct({ itemId: 'usd', currency: 'USD' }),
    eur: demoProduct({ itemId: 'eur', currency: 'EUR' }),
  });
  await cart.addItem('u1', { item_id: 'usd', quantity: 1 });
  await assert.rejects(
    cart.addItem('u1', { item_id: 'eur', quantity: 1 }),
    (error) => error.code === 'CONFLICT',
  );
});

test('a cart is bounded in distinct items', async () => {
  const products = {};
  for (let index = 0; index <= MAX_CART_ITEMS; index += 1) {
    products[`item-${index}`] = demoProduct({ itemId: `item-${index}`, availableQuantity: 99 });
  }
  const { cart } = setup(products);

  for (let index = 0; index < MAX_CART_ITEMS; index += 1) {
    await cart.addItem('u1', { item_id: `item-${index}`, quantity: 1 });
  }
  await assert.rejects(
    cart.addItem('u1', { item_id: `item-${MAX_CART_ITEMS}`, quantity: 1 }),
    (error) => error.code === 'BAD_REQUEST',
  );
});

test('updating a quantity to zero removes the item', async () => {
  const { cart } = setup({ 'item-1': demoProduct() });
  await cart.addItem('u1', { item_id: 'item-1', quantity: 2 });
  const removed = await cart.updateItem('u1', 'item-1', 0);
  assert.deepEqual(removed.items, []);
  assert.equal(cart.toView(removed).subtotal, 0);
});

test('updating an item that is not in the cart is a NOT_FOUND', async () => {
  const { cart } = setup({ 'item-1': demoProduct() });
  await assert.rejects(cart.updateItem('u1', 'item-1', 1), (error) => error.code === 'NOT_FOUND');
});

test('carts are isolated per user', async () => {
  const { cart } = setup({ 'item-1': demoProduct() });
  await cart.addItem('u1', { item_id: 'item-1', quantity: 1 });
  assert.deepEqual((await cart.getCart('u2')).items, []);
});

test('a view over a cart holding two currencies reports a conflict', () => {
  const { cart } = setup({});
  assert.throws(
    () =>
      cart.toView({
        userId: 'u1',
        updatedAt: '2025-01-01T00:00:00.000Z',
        items: [
          { itemId: 'a', title: 'A', quantity: 1, unitPrice: 1, currency: 'USD', addedAt: '', updatedAt: '' },
          { itemId: 'b', title: 'B', quantity: 1, unitPrice: 1, currency: 'EUR', addedAt: '', updatedAt: '' },
        ],
      }),
    (error) => error.code === 'CONFLICT',
  );
});
