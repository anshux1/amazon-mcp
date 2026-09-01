import { Injectable, type ExecutionContext } from '@nitrostack/core';
import { UnauthorizedError } from '../../common/errors.js';

/** Centralizes trusted user resolution for all protected tools. */
@Injectable()
export class AuthService {
  getUserId(context: ExecutionContext): string {
    const subject = context.auth?.subject;
    if (!subject) {
      throw new UnauthorizedError();
    }
    return subject;
  }

  getUser(context: ExecutionContext): {
    userId: string;
    scopes: string[];
    claims: Record<string, unknown>;
  } {
    const userId = this.getUserId(context);
    return {
      userId,
      scopes: context.auth?.scopes ?? [],
      claims: context.auth?.tokenPayload ?? {},
    };
  }
}
