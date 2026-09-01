import { Module } from '@nitrostack/core';
import { DatabaseService } from './database.service.js';

@Module({
  name: 'database',
  description: 'Postgres/Neon persistence with a local JSON fallback',
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
