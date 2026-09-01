import {
  ExceptionFilter,
  McpError,
  type ExceptionFilterInterface,
  type ExecutionContext,
} from '@nitrostack/core';
import type { StandardFailure } from '../types.js';

/** Converts expected domain failures into a stable, non-sensitive tool payload. */
@ExceptionFilter()
export class ShoppingExceptionFilter implements ExceptionFilterInterface {
  catch(exception: unknown, context: ExecutionContext): StandardFailure {
    const isMcpError = exception instanceof McpError;
    const rawMessage = exception instanceof Error ? exception.message : String(exception);
    const isRateLimited = !isMcpError && /rate limit|daily request budget/i.test(rawMessage);
    const code = isMcpError ? exception.code : isRateLimited ? 'RATE_LIMITED' : 'INTERNAL_ERROR';
    const message = isMcpError
      ? exception.message
      : isRateLimited
        ? rawMessage
        : 'An unexpected error occurred while processing the request';
    const statusCode = isMcpError ? exception.statusCode : isRateLimited ? 429 : 500;

    context.logger.error('Exception mapped to tool response', {
      tool: context.toolName ?? 'unknown',
      requestId: context.requestId,
      code,
      statusCode,
      message: rawMessage,
    });

    return {
      success: false,
      data: null,
      error: {
        code,
        message,
        statusCode,
        ...(isMcpError && exception.details !== undefined ? { details: exception.details } : {}),
      },
      timestamp: new Date().toISOString(),
      requestId: context.requestId,
      tool: context.toolName,
    };
  }
}
