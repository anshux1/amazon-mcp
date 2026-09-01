import { Interceptor, type ExecutionContext, type InterceptorInterface } from '@nitrostack/core';
import type { StandardResponse } from '../types.js';

function isStandardResponse(value: unknown): value is StandardResponse<unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    'success' in value &&
    'timestamp' in value &&
    'requestId' in value
  );
}

/** Gives every successful tool call the same response contract. */
@Interceptor()
export class ResponseTransformInterceptor implements InterceptorInterface {
  async intercept(context: ExecutionContext, next: () => Promise<unknown>): Promise<unknown> {
    const result = await next();
    if (isStandardResponse(result)) {
      return result;
    }

    return {
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
      requestId: context.requestId,
    } satisfies StandardResponse<unknown>;
  }
}
