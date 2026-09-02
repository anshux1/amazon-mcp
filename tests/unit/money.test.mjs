import assert from 'node:assert/strict';
import test from 'node:test';
import { addMoney, formatMoney, parseMoney, roundMoney } from '../../dist/common/money.js';

test('roundMoney rounds to two decimals away from float error', () => {
  assert.equal(roundMoney(1.005), 1.01);
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(roundMoney(79.99 * 3), 239.97);
  assert.equal(roundMoney(-0), 0);
});

test('parseMoney accepts numeric strings and falls back for junk', () => {
  assert.equal(parseMoney('12.345'), 12.35);
  assert.equal(parseMoney(7), 7);
  assert.equal(parseMoney(undefined), 0);
  assert.equal(parseMoney('not-a-number'), 0);
  assert.equal(parseMoney('not-a-number', 5), 5);
  assert.equal(parseMoney(Number.POSITIVE_INFINITY), 0);
});

test('addMoney sums without accumulating float drift', () => {
  assert.equal(addMoney([0.1, 0.2, 0.3]), 0.6);
  assert.equal(addMoney([]), 0);
  assert.equal(addMoney([19.99, 4.99, 0.01]), 24.99);
});

test('formatMoney keeps the currency the caller supplied', () => {
  assert.deepEqual(formatMoney(1.005, 'EUR'), { value: 1.01, currency: 'EUR' });
});
