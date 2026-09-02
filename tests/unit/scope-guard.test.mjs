import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getRequiredShoppingScope,
  ScopeGuard,
  SHOPPING_READ_SCOPE,
  SHOPPING_TOOL_SCOPES,
  SHOPPING_WRITE_SCOPE,
} from '../../dist/modules/auth/scope.guard.js';
import { makeContext } from '../helpers.mjs';

const guard = new ScopeGuard();

test('every protected tool has an explicit scope', () => {
  assert.deepEqual(Object.keys(SHOPPING_TOOL_SCOPES).sort(), [
    'add_to_cart',
    'cancel_order',
    'checkout',
    'get_order',
    'order_history',
    'place_order',
    'update_cart_item',
    'view_cart',
  ]);
  assert.equal(getRequiredShoppingScope('view_cart'), SHOPPING_READ_SCOPE);
  assert.equal(getRequiredShoppingScope('place_order'), SHOPPING_WRITE_SCOPE);
  assert.equal(getRequiredShoppingScope('search_products'), undefined);
});

test('a read-scoped token cannot reach a write tool', () => {
  const context = makeContext({ toolName: 'add_to_cart', auth: { subject: 'u1', scopes: ['shopping:read'] } });
  try {
    guard.canActivate(context);
    assert.fail('expected the write scope to be required');
  } catch (error) {
    assert.equal(error.code, 'FORBIDDEN');
    assert.equal(error.statusCode, 403);
    assert.equal(error.details.requiredScope, 'shopping:write');
  }
});

test('a write-scoped token cannot reach a read tool', () => {
  assert.throws(
    () => guard.canActivate(makeContext({ toolName: 'view_cart', auth: { subject: 'u1', scopes: ['shopping:write'] } })),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('a token with no scopes is rejected for every protected tool', () => {
  for (const tool of Object.keys(SHOPPING_TOOL_SCOPES)) {
    assert.throws(
      () => guard.canActivate(makeContext({ toolName: tool, auth: { subject: 'u1', scopes: [] } })),
      (error) => error.code === 'FORBIDDEN',
      `${tool} accepted a token with no scopes`,
    );
  }
});

test('a token holding both scopes reaches every protected tool', () => {
  for (const tool of Object.keys(SHOPPING_TOOL_SCOPES)) {
    assert.equal(
      guard.canActivate(makeContext({ toolName: tool, auth: { subject: 'u1', scopes: ['shopping:read', 'shopping:write'] } })),
      true,
    );
  }
});

test('an unmapped tool name is allowed through', () => {
  assert.equal(guard.canActivate(makeContext({ toolName: 'future_tool', auth: { subject: 'u1', scopes: [] } })), true);
});
