import { createHash } from 'node:crypto';
import type { Cart, CartItem } from './types.js';

/**
 * A stable fingerprint of the parts of a cart an order depends on.
 *
 * Checkout binds a quote to this value so `place_order` can detect that the
 * shopper changed the cart after the quote was produced. Only fields that
 * affect the money or the fulfilled goods participate: display-only metadata
 * such as an image URL must not invalidate an otherwise valid quote.
 */
export function computeCartRevision(cart: Pick<Cart, 'items'> | null | undefined): string {
  const items = [...(cart?.items ?? [])]
    .map((item: CartItem) => ({
      itemId: item.itemId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      currency: item.currency,
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));

  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

/** The revision of a cart that does not exist or holds no items. */
export const EMPTY_CART_REVISION = computeCartRevision({ items: [] });
