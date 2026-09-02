import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InstrumentedCacheStorage,
  MetricsService,
} from '../../dist/observability/metrics.service.js';
import { MetricsResources } from '../../dist/observability/metrics.resources.js';

test('tool counters record invocations, failures, and error codes', () => {
  const metrics = new MetricsService();
  metrics.reset();

  metrics.recordToolInvocation('view_cart', 10);
  metrics.recordToolInvocation('view_cart', 30);
  metrics.recordToolInvocation('view_cart', 20, 'UNAUTHORIZED');

  const snapshot = metrics.snapshot().tools.view_cart;
  assert.equal(snapshot.invocations, 3);
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.averageDurationMs, 20);
  assert.equal(snapshot.maxDurationMs, 30);
  assert.deepEqual(snapshot.errorCodes, { UNAUTHORIZED: 1 });
});

test('eBay counters track categories and reset the consecutive-failure streak', () => {
  const metrics = new MetricsService();
  metrics.reset();

  metrics.recordEbayRequest('browse.search', 100);
  metrics.recordEbayRequest('browse.search', 200, 'timeout');
  metrics.recordEbayRequest('browse.search', 50, 'timeout');
  metrics.recordEbayRetry('browse.search');
  assert.equal(metrics.getConsecutiveEbayFailures(), 2);

  metrics.recordEbayRequest('browse.search', 40);
  assert.equal(metrics.getConsecutiveEbayFailures(), 0);

  const snapshot = metrics.snapshot().ebay;
  assert.equal(snapshot.totalRequests, 4);
  assert.equal(snapshot.totalFailures, 2);
  assert.equal(snapshot.operations['browse.search'].retries, 1);
  assert.deepEqual(snapshot.operations['browse.search'].failureCategories, { timeout: 2 });
  assert.ok(snapshot.lastSuccessAt);
  assert.ok(snapshot.lastFailureAt);
});

test('the instrumented cache reports hits, misses, and expiry', async () => {
  const metrics = new MetricsService();
  metrics.reset();
  const cache = new InstrumentedCacheStorage('catalog');

  assert.equal(cache.get('a'), null);
  cache.set('a', { value: 1 }, 60);
  assert.deepEqual(cache.get('a'), { value: 1 });
  assert.deepEqual(cache.get('a'), { value: 1 });

  cache.set('b', 'x', 0.01);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cache.get('b'), null);

  const snapshot = metrics.snapshot().cache.catalog;
  assert.equal(snapshot.hits, 2);
  assert.equal(snapshot.misses, 2);
  assert.equal(snapshot.hitRate, 0.5);

  cache.delete('a');
  assert.equal(cache.get('a'), null);
  cache.clear();
});

test('reset clears every counter', () => {
  const metrics = new MetricsService();
  metrics.recordToolInvocation('x', 1);
  metrics.reset();
  assert.deepEqual(metrics.snapshot().tools, {});
  assert.equal(metrics.snapshot().ebay.totalRequests, 0);
});

test('alerts fire on sustained failures, an exhausted budget, and a dead counter', () => {
  const healthy = MetricsResources.evaluateAlerts({
    consecutiveEbayFailures: 0,
    quotaRemaining: 4500,
    quotaLimit: 4500,
    quotaDegraded: false,
  });
  assert.deepEqual(healthy, []);

  const low = MetricsResources.evaluateAlerts({
    consecutiveEbayFailures: 0,
    quotaRemaining: 100,
    quotaLimit: 4500,
    quotaDegraded: false,
  });
  assert.deepEqual(low.map((alert) => alert.name), ['ebay_quota_low']);
  assert.equal(low[0].severity, 'warning');

  const critical = MetricsResources.evaluateAlerts({
    consecutiveEbayFailures: 25,
    quotaRemaining: 0,
    quotaLimit: 4500,
    quotaDegraded: true,
  });
  assert.deepEqual(critical.map((alert) => alert.name), [
    'ebay_sustained_failures',
    'ebay_quota_exhausted',
    'ebay_quota_backend_unavailable',
  ]);
  assert.ok(critical.every((alert) => alert.severity === 'critical'));
});
