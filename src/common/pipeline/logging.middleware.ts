import { Middleware, type ExecutionContext, type MiddlewareInterface } from '@nitrostack/core';

/** Logs every MCP tool invocation without writing protocol data to stdout. */
@Middleware()
export class LoggingMiddleware implements MiddlewareInterface {
  async use(context: ExecutionContext, next: () => Promise<unknown>): Promise<unknown> {
    const startedAt = Date.now();
    const tool = context.toolName ?? 'unknown';

    context.logger.info('Tool started', {
      tool,
      requestId: context.requestId,
      userId: context.auth?.subject ?? 'anonymous',
    });

    try {
      const result = await next();
      context.logger.info('Tool completed', {
        tool,
        requestId: context.requestId,
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return result;
    } catch (error) {
      context.logger.error('Tool failed', {
        tool,
        requestId: context.requestId,
        durationMs: Date.now() - startedAt,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
