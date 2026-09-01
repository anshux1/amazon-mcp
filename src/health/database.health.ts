import { HealthCheck, type HealthCheckInterface, type HealthCheckResult, Injectable } from '@nitrostack/core';
import { DatabaseService } from '../database/database.service.js';

@Injectable({ deps: [DatabaseService] })
@HealthCheck({
  name: 'database',
  description: 'Shopping cart and order persistence connectivity',
  interval: 30,
})
export class DatabaseHealthCheck implements HealthCheckInterface {
  constructor(private readonly database: DatabaseService) {}

  async check(): Promise<HealthCheckResult> {
    const healthy = await this.database.ping();
    const initializationError = this.database.getInitializationError();

    return {
      status: healthy ? 'up' : 'down',
      message: healthy ? 'Database is reachable' : 'Database is unavailable',
      details: {
        mode: this.database.getMode(),
        ...(initializationError ? { error: 'Database initialization failed; inspect server configuration' } : {}),
      },
      timestamp: Date.now(),
    };
  }
}
