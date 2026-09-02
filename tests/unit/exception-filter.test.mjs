import assert from 'node:assert/strict';
import test from 'node:test';
import { ShoppingExceptionFilter } from '../../dist/common/pipeline/exception.filter.js';
import { ResponseTransformInterceptor } from '../../dist/common/pipeline/response.interceptor.js';
import {
  BadRequestError,
  ConflictError,
  DatabaseUnavailableError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  OutOfStockError,
  UnauthorizedError,
} from '../../dist/common/errors.js';
import { makeContext } from '../helpers.mjs';

const filter = new ShoppingExceptionFilter();

const cases = [
  [new UnauthorizedError(), 'UNAUTHORIZED', 401],
  [new ForbiddenError(), 'FORBIDDEN', 403],
  [new BadRequestError('bad'), 'BAD_REQUEST', 400],
  [new NotFoundError('Order', 'ord_1'), 'NOT_FOUND', 404],
  [new ConflictError('conflict'), 'CONFLICT', 409],
  [new OutOfStockError('item', 3, 1), 'OUT_OF_STOCK', 409],
  [new DatabaseUnavailableError(), 'DATABASE_UNAVAILABLE', 503],
  [new ExternalServiceError('eBay Browse API', 'boom'), 'EXTERNAL_SERVICE_ERROR', 502],
];

for (const [error, code, statusCode] of cases) {
  test(`${code} keeps its code and status in the standard envelope`, () => {
    const result = filter.catch(error, makeContext({ toolName: 'view_cart' }));
    assert.equal(result.success, false);
    assert.equal(result.data, null);
    assert.equal(result.error.code, code);
    assert.equal(result.error.statusCode, statusCode);
    assert.equal(result.tool, 'view_cart');
    assert.equal(result.requestId, 'test-request');
    assert.ok(Date.parse(result.timestamp) > 0);
  });
}

test('a rate-limit failure from the framework becomes RATE_LIMITED', () => {
  const result = filter.catch(
    new Error('eBay daily request budget is temporarily exhausted; try again tomorrow'),
    makeContext(),
  );
  assert.equal(result.error.code, 'RATE_LIMITED');
  assert.equal(result.error.statusCode, 429);
  assert.match(result.error.message, /daily request budget/);
});

test('an unexpected error never leaks its message to the client', () => {
  const result = filter.catch(new Error('connection string postgres://user:pw@host/db'), makeContext());
  assert.equal(result.error.code, 'INTERNAL_ERROR');
  assert.equal(result.error.statusCode, 500);
  assert.equal(result.error.message, 'An unexpected error occurred while processing the request');
});

test('the interceptor wraps a payload once and leaves an envelope alone', async () => {
  const interceptor = new ResponseTransformInterceptor();
  const wrapped = await interceptor.intercept(makeContext(), async () => ({ itemCount: 1 }));
  assert.equal(wrapped.success, true);
  assert.deepEqual(wrapped.data, { itemCount: 1 });

  const failure = filter.catch(new NotFoundError('Order', 'x'), makeContext());
  const passthrough = await interceptor.intercept(makeContext(), async () => failure);
  assert.equal(passthrough, failure);
});
