import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EBAY_DAILY_REQUEST_LIMIT,
  EBAY_DAILY_WINDOW_MS,
  EbayQuotaStorage,
} from '../../dist/modules/products/ebay-quota.js';
import { MetricsService } from '../../dist/observability/metrics.service.js';

/** A shared counter standing in for the Postgres-backed bucket. */
function sharedBackend() {
  const state = { count: 0, windowStart: Date.now(), failing: false };
  return {
    state,
    async increment(_bucket, windowMs) {
      if (state.failing) throw new Error('counter unavailable');
      if (state.windowStart + windowMs <= Date.now()) {
        state.windowStart = Date.now();
        state.count = 0;
      }
      state.count += 1;
      return { count: state.count, resetAt: state.windowStart + windowMs };
    },
    async read(_bucket, windowMs) {
      if (state.failing) throw new Error('counter unavailable');
      return { count: state.count, resetAt: state.windowStart + windowMs };
    },
    async reset() {
      state.count = 0;
    },
  };
}

test('a process-local bucket counts every catalog request in one budget', async () => {
  const storage = new EbayQuotaStorage();
  storage.configure({ backend: null, fallback: 'reject', metrics: new MetricsService() });

  assert.equal(await storage.increment('ProductsTools:searchProducts:ebay-global', EBAY_DAILY_WINDOW_MS), 1);
  assert.equal(await storage.increment('ProductsTools:getProduct:ebay-global', EBAY_DAILY_WINDOW_MS), 2);
  assert.equal(await storage.increment('ProductsTools:getCategories:ebay-global', EBAY_DAILY_WINDOW_MS), 3);

  const snapshot = await storage.snapshot();
  assert.equal(snapshot.scope, 'process');
  assert.equal(snapshot.count, 3);
  assert.equal(snapshot.remaining, EBAY_DAILY_REQUEST_LIMIT - 3);
});

test('the daily window resets the bucket', async () => {
  const storage = new EbayQuotaStorage();
  storage.configure({ backend: null, fallback: 'reject' });

  assert.equal(await storage.increment('k', 20), 1);
  assert.equal(await storage.increment('k', 20), 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await storage.increment('k', 20), 1, 'a new window restarts the count');
});

test('a shared backend is used by every instance and survives a restart', async () => {
  const backend = sharedBackend();
  const first = new EbayQuotaStorage();
  const second = new EbayQuotaStorage();
  first.configure({ backend, fallback: 'reject' });
  second.configure({ backend, fallback: 'reject' });

  assert.equal(await first.increment('k', EBAY_DAILY_WINDOW_MS), 1);
  assert.equal(await second.increment('k', EBAY_DAILY_WINDOW_MS), 2);

  // A restarted replica binds the same backend and continues the budget.
  const restarted = new EbayQuotaStorage();
  restarted.configure({ backend, fallback: 'reject' });
  assert.equal(await restarted.increment('k', EBAY_DAILY_WINDOW_MS), 3);
  assert.equal((await restarted.snapshot()).scope, 'shared');
  assert.equal((await restarted.snapshot()).count, 3);
});

test('concurrent increments across instances never reuse a count', async () => {
  const backend = sharedBackend();
  const instances = [new EbayQuotaStorage(), new EbayQuotaStorage(), new EbayQuotaStorage()];
  for (const instance of instances) instance.configure({ backend, fallback: 'reject' });

  const counts = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      instances[index % instances.length].increment('k', EBAY_DAILY_WINDOW_MS),
    ),
  );
  assert.deepEqual([...counts].sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i + 1));
});

test('an exhausted budget keeps returning counts above the limit', async () => {
  const backend = sharedBackend();
  backend.state.count = EBAY_DAILY_REQUEST_LIMIT;
  const storage = new EbayQuotaStorage();
  const metrics = new MetricsService();
  metrics.reset();
  storage.configure({ backend, fallback: 'reject', metrics });

  const count = await storage.increment('k', EBAY_DAILY_WINDOW_MS);
  assert.ok(count > EBAY_DAILY_REQUEST_LIMIT, 'the decorator rejects when the count exceeds the limit');
  assert.equal((await storage.snapshot()).remaining, 0);
  assert.equal(metrics.snapshot().quota.rejections, 1);
});

test('an unavailable shared counter fails closed by default', async () => {
  const backend = sharedBackend();
  backend.state.failing = true;
  const metrics = new MetricsService();
  metrics.reset();
  const storage = new EbayQuotaStorage();
  storage.configure({ backend, fallback: 'reject', metrics });

  const count = await storage.increment('k', EBAY_DAILY_WINDOW_MS);
  assert.ok(count > EBAY_DAILY_REQUEST_LIMIT, 'requests are refused while the counter is unreachable');
  assert.equal(metrics.snapshot().quota.backendFailures, 1);
  assert.equal((await storage.snapshot()).degraded, true);
});

test('EBAY_QUOTA_FALLBACK=local degrades to a per-process budget instead', async () => {
  const backend = sharedBackend();
  backend.state.failing = true;
  const storage = new EbayQuotaStorage();
  storage.configure({ backend, fallback: 'local', metrics: new MetricsService() });

  assert.equal(await storage.increment('k', EBAY_DAILY_WINDOW_MS), 1);
  assert.equal(await storage.increment('k', EBAY_DAILY_WINDOW_MS), 2);
});

test('recovery from a backend outage returns to the shared count', async () => {
  const backend = sharedBackend();
  const storage = new EbayQuotaStorage();
  storage.configure({ backend, fallback: 'local', metrics: new MetricsService() });

  backend.state.failing = true;
  await storage.increment('k', EBAY_DAILY_WINDOW_MS);
  backend.state.failing = false;
  assert.equal(await storage.increment('k', EBAY_DAILY_WINDOW_MS), 1);
  assert.equal((await storage.snapshot()).degraded, false);
});
