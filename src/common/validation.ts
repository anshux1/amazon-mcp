import { z } from '@nitrostack/core';
import { BadRequestError } from './errors.js';

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestError(
      'Input validation failed',
      result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: issue.code,
      })),
    );
  }
  return result.data;
}
