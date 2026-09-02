import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Injectable, ConfigService } from '@nitrostack/core';
import { Pool, type PoolClient } from 'pg';
import { computeCartRevision } from '../common/cart-revision.js';
import { DatabaseUnavailableError } from '../common/errors.js';
import type { Cart, CheckoutQuote, DatabaseState, Order } from '../common/types.js';

const EMPTY_STATE: DatabaseState = {
  version: 2,
  carts: {},
  orders: {},
  quotes: {},
};

type StorageMode = 'postgres' | 'file' | 'memory';

/** Advisory-lock namespace so unrelated applications cannot collide with us. */
const MIGRATION_LOCK_ID = 8_275_401;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Versioned, forward-only schema migrations.
 *
 * Startup DDL alone cannot express a column addition or a backfill, so every
 * schema change is appended here with a new version. Each migration runs once,
 * inside a transaction, under a session advisory lock so concurrent replicas
 * cannot apply the same version twice.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'carts_and_orders',
    sql: `
      CREATE TABLE IF NOT EXISTS shopping_carts (
        user_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shopping_orders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shopping_orders_user_created_idx
        ON shopping_orders (user_id, created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'durable_checkout_quotes',
    sql: `
      CREATE TABLE IF NOT EXISTS shopping_quotes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        cart_revision TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shopping_quotes_user_created_idx
        ON shopping_quotes (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS shopping_quotes_expires_idx
        ON shopping_quotes (expires_at);
      ALTER TABLE shopping_orders ADD COLUMN IF NOT EXISTS quote_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS shopping_orders_quote_idx
        ON shopping_orders (quote_id) WHERE quote_id IS NOT NULL;
    `,
  },
  {
    version: 3,
    name: 'shared_ebay_quota',
    sql: `
      CREATE TABLE IF NOT EXISTS ebay_quota (
        bucket TEXT PRIMARY KEY,
        window_start TIMESTAMPTZ NOT NULL,
        count INTEGER NOT NULL
      );
    `,
  },
];

export type PlacementOutcome =
  | { outcome: 'placed'; order: Order }
  | { outcome: 'already_placed'; order: Order }
  | { outcome: 'not_found' }
  | { outcome: 'expired' }
  | { outcome: 'cart_changed'; currentRevision: string };

export interface QuotaCounter {
  count: number;
  resetAt: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Upgrades an older on-disk state document to the current shape. */
function migrateState(value: unknown): DatabaseState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const state = value as Omit<Partial<DatabaseState>, 'version'> & { version?: number };
  if (state.version !== 1 && state.version !== 2) {
    return null;
  }
  if (!state.carts || typeof state.carts !== 'object' || !state.orders || typeof state.orders !== 'object') {
    return null;
  }

  return {
    version: 2,
    carts: state.carts as Record<string, Cart>,
    orders: Object.fromEntries(
      Object.entries(state.orders as Record<string, Order>).map(([id, order]) => [
        id,
        { ...order, fulfillment: order.fulfillment ?? 'demo' },
      ]),
    ),
    quotes: (state.quotes && typeof state.quotes === 'object'
      ? state.quotes
      : {}) as Record<string, CheckoutQuote>,
  };
}

/**
 * Persistence adapter used by the cart, checkout, order, and quota services.
 *
 * Production deployments use Postgres/Neon through DATABASE_URL, which is the
 * only mode that supports more than one replica. Local demos use an atomic
 * JSON file, and tests can explicitly select :memory:.
 */
@Injectable({ deps: [ConfigService] })
export class DatabaseService {
  private readonly mode: StorageMode;
  private readonly filePath?: string;
  private readonly databaseUrl?: string;
  private readonly config: ConfigService;
  private pool: Pool | null = null;
  private state: DatabaseState = clone(EMPTY_STATE);
  private initialized = false;
  private initializationPromise?: Promise<void>;
  private initializationError?: Error;
  private appliedMigrations: number[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(config: ConfigService) {
    this.config = config;
    this.databaseUrl = config.get<string>('DATABASE_URL');

    if (this.databaseUrl?.startsWith('postgres://') || this.databaseUrl?.startsWith('postgresql://')) {
      this.mode = 'postgres';
    } else if (config.get<string>('DATABASE_FILE', '.data/shopping-db.json') === ':memory:') {
      this.mode = 'memory';
    } else {
      this.mode = 'file';
      this.filePath = path.resolve(
        process.cwd(),
        config.get<string>('DATABASE_FILE', '.data/shopping-db.json'),
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeStorage();
    }

    await this.initializationPromise;
  }

  private async initializeStorage(): Promise<void> {
    try {
      if (this.mode === 'postgres') {
        const sslEnabled = this.config.get<string>('DATABASE_SSL', 'false') === 'true';
        const rejectUnauthorized = this.config.get<string>('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';
        const connectionTimeout = Number(this.config.get<string>('DATABASE_CONNECTION_TIMEOUT_MS', '10000'));
        const statementTimeout = Number(this.config.get<string>('DATABASE_STATEMENT_TIMEOUT_MS', '15000'));
        this.pool = new Pool({
          connectionString: this.databaseUrl,
          max: Number(this.config.get<string>('DATABASE_POOL_MAX', '10')),
          ssl: sslEnabled ? { rejectUnauthorized } : undefined,
          connectionTimeoutMillis: Number.isFinite(connectionTimeout) ? connectionTimeout : 10_000,
          statement_timeout: Number.isFinite(statementTimeout) ? statementTimeout : 15_000,
        });
        // A pool error outside a query (a dropped backend, a failover) would
        // otherwise reach the process as an unhandled 'error' event.
        this.pool.on('error', () => undefined);
        await this.runMigrations(this.pool);
      } else if (this.mode === 'file' && this.filePath) {
        try {
          const raw = await fs.readFile(this.filePath, 'utf8');
          const migrated = migrateState(JSON.parse(raw) as unknown);
          if (!migrated) {
            throw new Error('database file has an unsupported format');
          }
          this.state = migrated;
        } catch (error) {
          const fileError = error as NodeJS.ErrnoException;
          if (fileError.code !== 'ENOENT') {
            throw error;
          }
        }
      }
    } catch (error) {
      this.initializationError = error instanceof Error ? error : new Error(String(error));
      if (this.pool) {
        await this.pool.end().catch(() => undefined);
        this.pool = null;
      }
    } finally {
      this.initialized = true;
    }
  }

  /** Applies pending migrations exactly once, even with concurrent replicas. */
  private async runMigrations(pool: Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shopping_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      const applied = await client.query<{ version: number }>(
        'SELECT version FROM shopping_schema_migrations ORDER BY version',
      );
      const appliedVersions = new Set(applied.rows.map((row) => Number(row.version)));

      for (const migration of MIGRATIONS) {
        if (appliedVersions.has(migration.version)) {
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO shopping_schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [migration.version, migration.name],
          );
          await client.query('COMMIT');
          appliedVersions.add(migration.version);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }
      this.appliedMigrations = [...appliedVersions].sort((a, b) => a - b);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
      client.release();
    }
  }

  private async ensureReady(): Promise<void> {
    await this.initialize();
    if (this.initializationError) {
      // Keep connection details in health/logging channels, never in tool output.
      throw new DatabaseUnavailableError();
    }
  }

  private async enqueueWrite<T>(operation: () => Promise<T> | T): Promise<T> {
    let result!: T;
    const run = async () => {
      result = await operation();
    };
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    await next;
    return result;
  }

  private async persistFile(): Promise<void> {
    if (this.mode !== 'file' || !this.filePath) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, this.filePath);
  }

  /** Runs a callback inside a transaction that holds this user's row lock. */
  private async withUserLock<T>(userId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.pool;
    if (!pool) {
      throw new DatabaseUnavailableError();
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A transaction-scoped advisory lock serializes this user's cart, quote,
      // and order writes across every replica, including the case where the
      // cart row does not exist yet and SELECT ... FOR UPDATE locks nothing.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  getMode(): StorageMode {
    return this.mode;
  }

  /** True when this deployment can safely run more than one replica. */
  supportsReplicas(): boolean {
    return this.mode === 'postgres';
  }

  getAppliedMigrations(): number[] {
    return [...this.appliedMigrations];
  }

  getInitializationError(): string | undefined {
    return this.initializationError?.message;
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureReady();
      if (this.pool) {
        await this.pool.query('SELECT 1');
      }
      return true;
    } catch {
      return false;
    }
  }

  async getCart(userId: string): Promise<Cart | null> {
    await this.ensureReady();
    if (this.pool) {
      const result = await this.pool.query<{ data: Cart }>(
        'SELECT data FROM shopping_carts WHERE user_id = $1',
        [userId],
      );
      return result.rows[0] ? clone(result.rows[0].data) : null;
    }

    const cart = this.state.carts[userId];
    return cart ? clone(cart) : null;
  }

  async saveCart(cart: Cart): Promise<void> {
    await this.ensureReady();
    const value = clone(cart);

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO shopping_carts (user_id, data, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [value.userId, JSON.stringify(value), value.updatedAt],
      );
      return;
    }

    await this.enqueueWrite(async () => {
      this.state.carts[value.userId] = value;
      await this.persistFile();
    });
  }

  /**
   * Reads, mutates, and writes a cart as one atomic operation.
   *
   * `mutate` must be synchronous and side-effect free: it runs while this
   * user's row lock (Postgres) or the single-process write queue (file and
   * memory) is held, so a concurrent add_to_cart cannot lose an update.
   */
  async mutateCart(userId: string, mutate: (cart: Cart | null) => Cart): Promise<Cart> {
    await this.ensureReady();

    if (this.pool) {
      return this.withUserLock(userId, async (client) => {
        const existing = await client.query<{ data: Cart }>(
          'SELECT data FROM shopping_carts WHERE user_id = $1 FOR UPDATE',
          [userId],
        );
        const next = mutate(existing.rows[0] ? clone(existing.rows[0].data) : null);
        await client.query(
          `INSERT INTO shopping_carts (user_id, data, updated_at)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
          [userId, JSON.stringify(next), next.updatedAt],
        );
        return clone(next);
      });
    }

    return this.enqueueWrite(async () => {
      const existing = this.state.carts[userId];
      const next = mutate(existing ? clone(existing) : null);
      this.state.carts[userId] = clone(next);
      await this.persistFile();
      return clone(next);
    });
  }

  async getOrder(userId: string, orderId: string): Promise<Order | null> {
    await this.ensureReady();
    if (this.pool) {
      const result = await this.pool.query<{ data: Order }>(
        'SELECT data FROM shopping_orders WHERE id = $1 AND user_id = $2',
        [orderId, userId],
      );
      return result.rows[0] ? clone(result.rows[0].data) : null;
    }

    const order = this.state.orders[orderId];
    return order && order.userId === userId ? clone(order) : null;
  }

  async listOrders(userId: string): Promise<Order[]> {
    await this.ensureReady();
    if (this.pool) {
      const result = await this.pool.query<{ data: Order }>(
        'SELECT data FROM shopping_orders WHERE user_id = $1 ORDER BY created_at DESC',
        [userId],
      );
      return result.rows.map((row) => clone(row.data));
    }

    return Object.values(this.state.orders)
      .filter((order) => order.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((order) => clone(order));
  }

  async saveOrder(order: Order): Promise<void> {
    await this.ensureReady();
    const value = clone(order);

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO shopping_orders (id, user_id, status, data, created_at, updated_at, quote_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,
           data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [
          value.id,
          value.userId,
          value.status,
          JSON.stringify(value),
          value.createdAt,
          value.updatedAt,
          value.quoteId ?? null,
        ],
      );
      return;
    }

    await this.enqueueWrite(async () => {
      this.state.orders[value.id] = value;
      await this.persistFile();
    });
  }

  async saveQuote(quote: CheckoutQuote): Promise<void> {
    await this.ensureReady();
    const value = clone(quote);

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO shopping_quotes (id, user_id, status, cart_revision, data, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,
           cart_revision = EXCLUDED.cart_revision, data = EXCLUDED.data`,
        [
          value.id,
          value.userId,
          value.status,
          value.cartRevision,
          JSON.stringify(value),
          value.createdAt,
          value.expiresAt,
        ],
      );
      return;
    }

    await this.enqueueWrite(async () => {
      this.state.quotes[value.id] = value;
      await this.persistFile();
    });
  }

  async getQuote(userId: string, quoteId: string): Promise<CheckoutQuote | null> {
    await this.ensureReady();
    if (this.pool) {
      const result = await this.pool.query<{ data: CheckoutQuote }>(
        'SELECT data FROM shopping_quotes WHERE id = $1 AND user_id = $2',
        [quoteId, userId],
      );
      return result.rows[0] ? clone(result.rows[0].data) : null;
    }

    const quote = this.state.quotes[quoteId];
    return quote && quote.userId === userId ? clone(quote) : null;
  }

  async listQuotes(userId: string): Promise<CheckoutQuote[]> {
    await this.ensureReady();
    if (this.pool) {
      const result = await this.pool.query<{ data: CheckoutQuote }>(
        'SELECT data FROM shopping_quotes WHERE user_id = $1 ORDER BY created_at DESC',
        [userId],
      );
      return result.rows.map((row) => clone(row.data));
    }

    return Object.values(this.state.quotes)
      .filter((quote) => quote.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((quote) => clone(quote));
  }

  /**
   * Removes quotes that expired before `before`. Consumed quotes are kept for
   * `retentionMs` after expiry so a late `place_order` retry still resolves to
   * the order it already created instead of looking like a missing checkout.
   */
  async deleteExpiredQuotes(before = new Date(), retentionMs = 24 * 60 * 60 * 1000): Promise<number> {
    await this.ensureReady();
    const cutoff = before.toISOString();
    const consumedCutoff = new Date(before.getTime() - retentionMs).toISOString();

    if (this.pool) {
      const result = await this.pool.query(
        `DELETE FROM shopping_quotes
         WHERE (status = 'active' AND expires_at <= $1)
            OR (status <> 'active' AND expires_at <= $2)`,
        [cutoff, consumedCutoff],
      );
      return result.rowCount ?? 0;
    }

    return this.enqueueWrite(async () => {
      let removed = 0;
      for (const [id, quote] of Object.entries(this.state.quotes)) {
        const expired = quote.status === 'active'
          ? quote.expiresAt <= cutoff
          : quote.expiresAt <= consumedCutoff;
        if (expired) {
          delete this.state.quotes[id];
          removed += 1;
        }
      }
      if (removed > 0) {
        await this.persistFile();
      }
      return removed;
    });
  }

  /**
   * Atomically consumes a checkout quote, stores its order, and clears the
   * cart the quote was produced from.
   *
   * The whole decision runs under this user's lock so two replicas cannot
   * place the same quote, and a cart that changed after checkout is never
   * destroyed by an older quote.
   */
  async placeOrderFromQuote(input: {
    quoteId: string;
    userId: string;
    order: Order;
    expectedCartRevision: string;
    now?: Date;
  }): Promise<PlacementOutcome> {
    await this.ensureReady();
    const now = input.now ?? new Date();
    const order = clone(input.order);

    const decide = (
      quote: CheckoutQuote | null,
      cart: Cart | null,
      loadOrder: (orderId: string) => Order | null,
    ): { result: PlacementOutcome; commit: boolean; quote?: CheckoutQuote } => {
      if (!quote || quote.userId !== input.userId) {
        return { result: { outcome: 'not_found' }, commit: false };
      }
      if (quote.status === 'consumed') {
        const existing = quote.placedOrderId ? loadOrder(quote.placedOrderId) : null;
        return existing
          ? { result: { outcome: 'already_placed', order: existing }, commit: false }
          : { result: { outcome: 'not_found' }, commit: false };
      }
      if (Date.parse(quote.expiresAt) <= now.getTime()) {
        return { result: { outcome: 'expired' }, commit: false };
      }

      const currentRevision = computeCartRevision(cart);
      if (currentRevision !== input.expectedCartRevision) {
        return { result: { outcome: 'cart_changed', currentRevision }, commit: false };
      }

      return {
        result: { outcome: 'placed', order },
        commit: true,
        quote: { ...quote, status: 'consumed', placedOrderId: order.id },
      };
    };

    if (this.pool) {
      return this.withUserLock(input.userId, async (client) => {
        const quoteRow = await client.query<{ data: CheckoutQuote }>(
          'SELECT data FROM shopping_quotes WHERE id = $1 FOR UPDATE',
          [input.quoteId],
        );
        const cartRow = await client.query<{ data: Cart }>(
          'SELECT data FROM shopping_carts WHERE user_id = $1 FOR UPDATE',
          [input.userId],
        );
        const quote = quoteRow.rows[0] ? clone(quoteRow.rows[0].data) : null;
        const cart = cartRow.rows[0] ? clone(cartRow.rows[0].data) : null;

        let loadedOrder: Order | null = null;
        if (quote?.status === 'consumed' && quote.placedOrderId) {
          const orderRow = await client.query<{ data: Order }>(
            'SELECT data FROM shopping_orders WHERE id = $1 AND user_id = $2',
            [quote.placedOrderId, input.userId],
          );
          loadedOrder = orderRow.rows[0] ? clone(orderRow.rows[0].data) : null;
        }

        const decision = decide(quote, cart, () => loadedOrder);
        if (!decision.commit || !decision.quote) {
          return decision.result;
        }

        await client.query(
          `INSERT INTO shopping_orders (id, user_id, status, data, created_at, updated_at, quote_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [
            order.id,
            order.userId,
            order.status,
            JSON.stringify(order),
            order.createdAt,
            order.updatedAt,
            order.quoteId ?? null,
          ],
        );
        await client.query(
          `UPDATE shopping_quotes SET status = $2, data = $3::jsonb WHERE id = $1`,
          [decision.quote.id, decision.quote.status, JSON.stringify(decision.quote)],
        );
        await client.query('DELETE FROM shopping_carts WHERE user_id = $1', [input.userId]);
        return decision.result;
      });
    }

    return this.enqueueWrite(async () => {
      const quote = this.state.quotes[input.quoteId] ?? null;
      const cart = this.state.carts[input.userId] ?? null;
      const decision = decide(
        quote ? clone(quote) : null,
        cart ? clone(cart) : null,
        (orderId) => {
          const existing = this.state.orders[orderId];
          return existing && existing.userId === input.userId ? clone(existing) : null;
        },
      );

      if (!decision.commit || !decision.quote) {
        return decision.result;
      }

      this.state.orders[order.id] = order;
      this.state.quotes[decision.quote.id] = decision.quote;
      delete this.state.carts[input.userId];
      await this.persistFile();
      return decision.result;
    });
  }

  /**
   * Atomically increments a shared quota bucket and returns the new count.
   *
   * Postgres is the only storage that survives a restart and is visible to
   * every replica, so it is the only backend that can enforce a hard daily
   * eBay application budget.
   */
  async incrementQuota(bucket: string, windowMs: number): Promise<QuotaCounter> {
    await this.ensureReady();
    if (!this.pool) {
      throw new DatabaseUnavailableError('A shared quota counter requires DATABASE_URL');
    }

    const result = await this.pool.query<{ count: number; window_start: Date }>(
      `INSERT INTO ebay_quota (bucket, window_start, count)
       VALUES ($1, now(), 1)
       ON CONFLICT (bucket) DO UPDATE SET
         window_start = CASE
           WHEN ebay_quota.window_start + make_interval(secs => $2::double precision) <= now()
           THEN now() ELSE ebay_quota.window_start END,
         count = CASE
           WHEN ebay_quota.window_start + make_interval(secs => $2::double precision) <= now()
           THEN 1 ELSE ebay_quota.count + 1 END
       RETURNING count, window_start`,
      [bucket, windowMs / 1000],
    );

    const row = result.rows[0];
    return {
      count: Number(row.count),
      resetAt: new Date(row.window_start).getTime() + windowMs,
    };
  }

  async readQuota(bucket: string, windowMs: number): Promise<QuotaCounter | null> {
    await this.ensureReady();
    if (!this.pool) {
      return null;
    }

    const result = await this.pool.query<{ count: number; window_start: Date }>(
      'SELECT count, window_start FROM ebay_quota WHERE bucket = $1',
      [bucket],
    );
    const row = result.rows[0];
    if (!row) {
      return { count: 0, resetAt: Date.now() + windowMs };
    }

    const resetAt = new Date(row.window_start).getTime() + windowMs;
    return resetAt <= Date.now()
      ? { count: 0, resetAt: Date.now() + windowMs }
      : { count: Number(row.count), resetAt };
  }

  async resetQuota(bucket: string): Promise<void> {
    await this.ensureReady();
    if (this.pool) {
      await this.pool.query('DELETE FROM ebay_quota WHERE bucket = $1', [bucket]);
    }
  }

  async clearForTests(): Promise<void> {
    await this.ensureReady();
    if (this.pool) {
      await this.pool.query('TRUNCATE shopping_orders, shopping_carts, shopping_quotes, ebay_quota');
      return;
    }

    await this.enqueueWrite(async () => {
      this.state = clone(EMPTY_STATE);
      await this.persistFile();
    });
  }

  async close(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
      this.pool = null;
    }
  }
}
