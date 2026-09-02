import { Injectable, type ExecutionContext, type Guard } from '@nitrostack/core';
import { ForbiddenError } from '../../common/errors.js';

export const SHOPPING_READ_SCOPE = 'shopping:read' as const;
export const SHOPPING_WRITE_SCOPE = 'shopping:write' as const;

export type ShoppingScope = typeof SHOPPING_READ_SCOPE | typeof SHOPPING_WRITE_SCOPE;

/**
 * The scope contract for authenticated shopping operations.
 * Catalog tools intentionally remain public; every tool listed here is
 * protected by JWTGuard followed by ScopeGuard.
 */
export const SHOPPING_TOOL_SCOPES: Readonly<Record<string, ShoppingScope>> = {
  view_cart: SHOPPING_READ_SCOPE,
  get_order: SHOPPING_READ_SCOPE,
  order_history: SHOPPING_READ_SCOPE,
  add_to_cart: SHOPPING_WRITE_SCOPE,
  update_cart_item: SHOPPING_WRITE_SCOPE,
  checkout: SHOPPING_WRITE_SCOPE,
  place_order: SHOPPING_WRITE_SCOPE,
  cancel_order: SHOPPING_WRITE_SCOPE,
};

export const SHOPPING_SCOPES = [SHOPPING_READ_SCOPE, SHOPPING_WRITE_SCOPE] as const;

export function getRequiredShoppingScope(toolName: string | undefined): ShoppingScope | undefined {
  return toolName ? SHOPPING_TOOL_SCOPES[toolName] : undefined;
}

/** Enforces the scope required by the current protected shopping tool. */
@Injectable()
export class ScopeGuard implements Guard {
  canActivate(context: ExecutionContext): boolean {
    const requiredScope = getRequiredShoppingScope(context.toolName);
    // This guard is only applied to protected tools. Returning true for an
    // unmapped name keeps it safe to reuse on a future authenticated endpoint
    // that has no shopping-scope mapping yet.
    if (!requiredScope) {
      return true;
    }

    const grantedScopes = new Set(context.auth?.scopes ?? []);
    if (!grantedScopes.has(requiredScope)) {
      throw new ForbiddenError(
        `The '${requiredScope}' scope is required for this tool`,
        { requiredScope, tool: context.toolName },
      );
    }
    return true;
  }
}

// A descriptive alias for callers that prefer the domain-specific name.
export { ScopeGuard as ShoppingScopeGuard };
