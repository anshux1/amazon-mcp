import { McpError } from '@nitrostack/core';

/** Base error for expected shopping-domain failures. */
export class ShoppingError extends McpError {
  constructor(
    message: string,
    code: string,
    statusCode: number,
    details?: unknown,
  ) {
    super(message, code, statusCode, details);
    this.name = 'ShoppingError';
  }
}

export class UnauthorizedError extends ShoppingError {
  constructor(message = 'Authentication is required') {
    super(message, 'UNAUTHORIZED', 401);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends ShoppingError {
  constructor(resource: string, identifier: string) {
    super(`${resource} '${identifier}' was not found`, 'NOT_FOUND', 404, {
      resource,
      identifier,
    });
    this.name = 'NotFoundError';
  }
}

export class OutOfStockError extends ShoppingError {
  constructor(itemId: string, requested: number, available: number) {
    super(
      `Item '${itemId}' has only ${available} unit(s) available; requested ${requested}`,
      'OUT_OF_STOCK',
      409,
      { itemId, requested, available },
    );
    this.name = 'OutOfStockError';
  }
}

export class ConflictError extends ShoppingError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFLICT', 409, details);
    this.name = 'ConflictError';
  }
}

export class BadRequestError extends ShoppingError {
  constructor(message: string, details?: unknown) {
    super(message, 'BAD_REQUEST', 400, details);
    this.name = 'BadRequestError';
  }
}

export class DatabaseUnavailableError extends ShoppingError {
  constructor(message = 'The shopping database is unavailable') {
    super(message, 'DATABASE_UNAVAILABLE', 503);
    this.name = 'DatabaseUnavailableError';
  }
}

export class ExternalServiceError extends ShoppingError {
  constructor(service: string, message: string, details?: unknown) {
    super(`${service} request failed: ${message}`, 'EXTERNAL_SERVICE_ERROR', 502, details);
    this.name = 'ExternalServiceError';
  }
}
