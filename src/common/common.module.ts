import { Module } from '@nitrostack/core';
import { ShoppingExceptionFilter } from './pipeline/exception.filter.js';
import { LoggingMiddleware } from './pipeline/logging.middleware.js';
import { NormalizeInputPipe } from './pipeline/normalize-input.pipe.js';
import { ResponseTransformInterceptor } from './pipeline/response.interceptor.js';

@Module({
  name: 'common',
  description: 'Shared shopping-server pipeline components',
  providers: [
    LoggingMiddleware,
    NormalizeInputPipe,
    ResponseTransformInterceptor,
    ShoppingExceptionFilter,
  ],
  exports: [
    LoggingMiddleware,
    NormalizeInputPipe,
    ResponseTransformInterceptor,
    ShoppingExceptionFilter,
  ],
})
export class CommonModule {}
