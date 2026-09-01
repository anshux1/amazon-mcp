import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Injectable, ConfigService } from '@nitrostack/core';
import { Pool } from 'pg';
import { DatabaseUnavailableError } from '../common/errors.js';
import type { Cart, DatabaseState, Order } from '../common/types.js';

const EMPTY_STATE: DatabaseState = {
  version: 1,
  carts: {},
  orders: {},
};

type StorageMode = 'postgres' | 'file' | 'memory';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isDatabaseState(value: unknown): value is DatabaseState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const state = value as Partial<DatabaseState>;
  return (
    state.version === 1 &&
    !!state.carts &&
    typeof state.carts === 'object' &&
    !!state.orders &&
    typeof state.orders === 'object'
  );
}

/**
 * Small persistence adapter used by cart and order services.
 *
 * Production deployments use Postgres/Neon through DATABASE_URL. Local demos
 * use an atomic JSON file, while tests can explicitly select :memory:.
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
        this.pool = new Pool({
          connectionString: this.databaseUrl,
          max: Number(this.config.get<string>('DATABASE_POOL_MAX', '10')),
          ssl: sslEnabled ? { rejectUnauthorized } : undefined,
        });
        await this.pool.query(`
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
        `);
      } else if (this.mode === 'file' && this.filePath) {
        try {
          const raw = await fs.readFile(this.filePath, 'utf8');
          const parsed: unknown = JSON.parse(raw);
          if (!isDatabaseState(parsed)) {
            throw new Error('database file has an unsupported format');
          }
          this.state = parsed;
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

  private async ensureReady(): Promise<void> {
    await this.initialize();
    if (this.initializationError) {
      // Keep connection details in health/logging channels, never in tool output.
      throw new DatabaseUnavailableError();
    }
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    await next;
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

  getMode(): StorageMode {
    return this.mode;
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
        `INSERT INTO shopping_orders (id, user_id, status, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,
           data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [
          value.id,
          value.userId,
          value.status,
          JSON.stringify(value),
          value.createdAt,
          value.updatedAt,
        ],
      );
      return;
    }

    await this.enqueueWrite(async () => {
      this.state.orders[value.id] = value;
      await this.persistFile();
    });
  }

  /** Persists an order and consumes its user's cart as one storage operation. */
  async saveOrderAndClearCart(order: Order): Promise<void> {
    await this.ensureReady();
    const value = clone(order);

    if (this.pool) {
      const pool = this.pool;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO shopping_orders (id, user_id, status, data, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,
             data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
          [
            value.id,
            value.userId,
            value.status,
            JSON.stringify(value),
            value.createdAt,
            value.updatedAt,
          ],
        );
        await client.query('DELETE FROM shopping_carts WHERE user_id = $1', [value.userId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      return;
    }

    await this.enqueueWrite(async () => {
      this.state.orders[value.id] = value;
      delete this.state.carts[value.userId];
      await this.persistFile();
    });
  }

  async clearForTests(): Promise<void> {
    await this.ensureReady();
    if (this.pool) {
      await this.pool.query('TRUNCATE shopping_orders, shopping_carts');
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
