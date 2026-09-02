import { McpError, Middleware, type ExecutionContext, type MiddlewareInterface } from '@nitrostack/core';
import { MetricsService } from '../../observability/metrics.service.js';

function errorCode(error: unknown): string {
  if (error instanceof McpError) {
    return error.code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|daily request budget/i.test(message) ? 'RATE_LIMITED' : 'INTERNAL_ERROR';
}

/**
 * Logs and counts every MCP tool invocation.
 *
 * Log records carry a request ID, the tool name, the authenticated subject,
 * and a duration. Tool input is deliberately not logged: it can contain a
 * shipping address, and `_meta.authorization` carries a bearer token.
 */
@Middleware()
export class LoggingMiddleware implements MiddlewareInterface {
  private readonly metrics = new MetricsService();

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
      const durationMs = Date.now() - startedAt;
      this.metrics.recordToolInvocation(tool, durationMs);
      context.logger.info('Tool completed', {
        tool,
        requestId: context.requestId,
        durationMs,
        success: true,
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const code = errorCode(error);
      this.metrics.recordToolInvocation(tool, durationMs, code);
      context.logger.error('Tool failed', {
        tool,
        requestId: context.requestId,
        durationMs,
        success: false,
        code,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
