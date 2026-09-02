import { Module } from '@nitrostack/core';
import { MetricsService } from './metrics.service.js';

@Module({
  name: 'observability',
  description: 'Dependency, cache, and quota counters shared by every module',
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
