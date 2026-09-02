import type { RateLimitStorage } from '@nitrostack/core';

export const EBAY_QUOTA_BUCKET = 'ebay-global';
export const EBAY_DAILY_REQUEST_LIMIT = 4500;
export const EBAY_DAILY_WINDOW = '1d';

interface QuotaBucket {
  count: number;
  resetAt: number;
}

/**
 * A single-process eBay application quota bucket.
 *
 * NitroStack prefixes a RateLimit key with the decorated class and method.
 * This storage deliberately ignores that prefix so search, item, and category
 * calls consume the same budget. It is intentionally small and synchronous
 * around the in-memory mutation; JavaScript's event loop cannot interleave two
 * increments in this critical section.
 *
 * Multi-replica deployments must replace this storage with a shared atomic
 * Redis/Postgres implementation before relying on the quota as a hard limit.
 */
export class EbayQuotaStorage implements RateLimitStorage {
  private bucket?: QuotaBucket;

  increment(_key: string, windowMs: number): number {
    const now = Date.now();
    if (!this.bucket || this.bucket.resetAt <= now) {
      this.bucket = { count: 1, resetAt: now + windowMs };
      return this.bucket.count;
    }

    this.bucket.count += 1;
    return this.bucket.count;
  }

  reset(_key: string): void {
    this.bucket = undefined;
  }

  getSnapshot(): { bucket: string; count: number; remaining: number; resetAt: number } {
    const now = Date.now();
    if (!this.bucket || this.bucket.resetAt <= now) {
      return {
        bucket: EBAY_QUOTA_BUCKET,
        count: 0,
        remaining: EBAY_DAILY_REQUEST_LIMIT,
        resetAt: now,
      };
    }

    return {
      bucket: EBAY_QUOTA_BUCKET,
      count: this.bucket.count,
      remaining: Math.max(0, EBAY_DAILY_REQUEST_LIMIT - this.bucket.count),
      resetAt: this.bucket.resetAt,
    };
  }
}

export const ebayQuotaStorage = new EbayQuotaStorage();
