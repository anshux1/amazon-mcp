import { Injectable, type CacheStorage } from '@nitrostack/core';

export type EbayFailureCategory =
  | 'not_found'
  | 'unauthorized'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'unknown';

export const EBAY_FAILURE_CATEGORIES: readonly EbayFailureCategory[] = [
  'not_found',
  'unauthorized',
  'rate_limited',
  'timeout',
  'network',
  'server_error',
  'unknown',
];

interface LatencySeries {
  count: number;
  totalMs: number;
  maxMs: number;
}

interface ToolMetrics extends LatencySeries {
  failures: number;
  errorCodes: Record<string, number>;
}

interface EbayMetrics extends LatencySeries {
  failures: number;
  retries: number;
  categories: Record<string, number>;
}

interface CacheMetrics {
  hits: number;
  misses: number;
}

interface QuotaMetrics {
  rejections: number;
  backendFailures: number;
}

interface MetricsState {
  startedAt: number;
  tools: Map<string, ToolMetrics>;
  ebay: Map<string, EbayMetrics>;
  cache: Map<string, CacheMetrics>;
  quota: QuotaMetrics;
  consecutiveEbayFailures: number;
  lastEbayFailureAt?: number;
  lastEbaySuccessAt?: number;
}

function newState(): MetricsState {
  return {
    startedAt: Date.now(),
    tools: new Map(),
    ebay: new Map(),
    cache: new Map(),
    quota: { rejections: 0, backendFailures: 0 },
    consecutiveEbayFailures: 0,
  };
}

// Metrics are process-wide: the DI container may build more than one instance
// of a provider, and every one of them must observe the same counters.
const state: MetricsState = newState();

function record(series: LatencySeries, durationMs: number): void {
  series.count += 1;
  series.totalMs += durationMs;
  series.maxMs = Math.max(series.maxMs, durationMs);
}

function toolMetrics(tool: string): ToolMetrics {
  let entry = state.tools.get(tool);
  if (!entry) {
    entry = { count: 0, totalMs: 0, maxMs: 0, failures: 0, errorCodes: {} };
    state.tools.set(tool, entry);
  }
  return entry;
}

function ebayMetrics(operation: string): EbayMetrics {
  let entry = state.ebay.get(operation);
  if (!entry) {
    entry = { count: 0, totalMs: 0, maxMs: 0, failures: 0, retries: 0, categories: {} };
    state.ebay.set(operation, entry);
  }
  return entry;
}

function cacheMetrics(namespace: string): CacheMetrics {
  let entry = state.cache.get(namespace);
  if (!entry) {
    entry = { hits: 0, misses: 0 };
    state.cache.set(namespace, entry);
  }
  return entry;
}

function averageMs(series: LatencySeries): number {
  return series.count === 0 ? 0 : Math.round((series.totalMs / series.count) * 100) / 100;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  tools: Record<string, {
    invocations: number;
    failures: number;
    averageDurationMs: number;
    maxDurationMs: number;
    errorCodes: Record<string, number>;
  }>;
  ebay: {
    operations: Record<string, {
      requests: number;
      failures: number;
      retries: number;
      averageLatencyMs: number;
      maxLatencyMs: number;
      failureCategories: Record<string, number>;
    }>;
    totalRequests: number;
    totalFailures: number;
    consecutiveFailures: number;
    lastFailureAt?: string;
    lastSuccessAt?: string;
  };
  cache: Record<string, { hits: number; misses: number; hitRate: number }>;
  quota: {
    rejections: number;
    backendFailures: number;
  };
}

/**
 * Process-wide counters for dependency and quota observability.
 *
 * Everything recorded here is safe to expose: tool names, operation names,
 * counts and durations only. Tokens, credentials, shipping addresses and raw
 * upstream payloads must never be passed to these methods.
 */
@Injectable()
export class MetricsService {
  recordToolInvocation(tool: string, durationMs: number, errorCode?: string): void {
    const entry = toolMetrics(tool);
    record(entry, durationMs);
    if (errorCode) {
      entry.failures += 1;
      entry.errorCodes[errorCode] = (entry.errorCodes[errorCode] ?? 0) + 1;
    }
  }

  recordEbayRequest(operation: string, durationMs: number, category?: EbayFailureCategory): void {
    const entry = ebayMetrics(operation);
    record(entry, durationMs);
    if (category) {
      entry.failures += 1;
      entry.categories[category] = (entry.categories[category] ?? 0) + 1;
      state.consecutiveEbayFailures += 1;
      state.lastEbayFailureAt = Date.now();
    } else {
      state.consecutiveEbayFailures = 0;
      state.lastEbaySuccessAt = Date.now();
    }
  }

  recordEbayRetry(operation: string): void {
    ebayMetrics(operation).retries += 1;
  }

  recordCacheHit(namespace: string): void {
    cacheMetrics(namespace).hits += 1;
  }

  recordCacheMiss(namespace: string): void {
    cacheMetrics(namespace).misses += 1;
  }

  recordQuotaRejection(): void {
    state.quota.rejections += 1;
  }

  recordQuotaBackendFailure(): void {
    state.quota.backendFailures += 1;
  }

  getConsecutiveEbayFailures(): number {
    return state.consecutiveEbayFailures;
  }

  snapshot(): MetricsSnapshot {
    const tools: MetricsSnapshot['tools'] = {};
    for (const [tool, entry] of state.tools) {
      tools[tool] = {
        invocations: entry.count,
        failures: entry.failures,
        averageDurationMs: averageMs(entry),
        maxDurationMs: entry.maxMs,
        errorCodes: { ...entry.errorCodes },
      };
    }

    const operations: MetricsSnapshot['ebay']['operations'] = {};
    let totalRequests = 0;
    let totalFailures = 0;
    for (const [operation, entry] of state.ebay) {
      totalRequests += entry.count;
      totalFailures += entry.failures;
      operations[operation] = {
        requests: entry.count,
        failures: entry.failures,
        retries: entry.retries,
        averageLatencyMs: averageMs(entry),
        maxLatencyMs: entry.maxMs,
        failureCategories: { ...entry.categories },
      };
    }

    const cache: MetricsSnapshot['cache'] = {};
    for (const [namespace, entry] of state.cache) {
      const total = entry.hits + entry.misses;
      cache[namespace] = {
        hits: entry.hits,
        misses: entry.misses,
        hitRate: total === 0 ? 0 : Math.round((entry.hits / total) * 10000) / 10000,
      };
    }

    return {
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
      tools,
      ebay: {
        operations,
        totalRequests,
        totalFailures,
        consecutiveFailures: state.consecutiveEbayFailures,
        lastFailureAt: state.lastEbayFailureAt ? new Date(state.lastEbayFailureAt).toISOString() : undefined,
        lastSuccessAt: state.lastEbaySuccessAt ? new Date(state.lastEbaySuccessAt).toISOString() : undefined,
      },
      cache: cache,
      quota: { ...state.quota },
    };
  }

  /** Clears every counter. Only used by tests. */
  reset(): void {
    const fresh = newState();
    state.startedAt = fresh.startedAt;
    state.tools = fresh.tools;
    state.ebay = fresh.ebay;
    state.cache = fresh.cache;
    state.quota = fresh.quota;
    state.consecutiveEbayFailures = 0;
    state.lastEbayFailureAt = undefined;
    state.lastEbaySuccessAt = undefined;
  }
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * A TTL cache that reports hits and misses.
 *
 * NitroStack's default cache storage is shared by every decorated method and
 * silent, which makes it impossible to tell an eBay request from a cache hit.
 * Catalog tools use this storage so `metrics://shopping` can report both.
 */
export class InstrumentedCacheStorage implements CacheStorage {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly metrics = new MetricsService();

  constructor(private readonly namespace: string) {}

  get(key: string): unknown {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) {
        this.entries.delete(key);
      }
      this.metrics.recordCacheMiss(this.namespace);
      return null;
    }
    this.metrics.recordCacheHit(this.namespace);
    return entry.value;
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
