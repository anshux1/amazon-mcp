import { Injectable } from '@nitrostack/core';
import { computeCartRevision } from '../../common/cart-revision.js';
import { addMoney, roundMoney } from '../../common/money.js';
import { BadRequestError, ConflictError, NotFoundError, OutOfStockError } from '../../common/errors.js';
import type { Cart, CartItem } from '../../common/types.js';
import { DatabaseService } from '../../database/database.service.js';
import { ProductsService } from '../products/products.service.js';

export const MAX_CART_ITEM_QUANTITY = 99;
export const MAX_CART_ITEMS = 50;

export interface AddCartItemInput {
  item_id: string;
  quantity: number;
}

export interface CartView {
  userId: string;
  items: CartItem[];
  itemCount: number;
  subtotal: number;
  currency: string;
  revision: string;
  updatedAt: string;
}

function newCart(userId: string): Cart {
  return { userId, items: [], updatedAt: new Date().toISOString() };
}

@Injectable({ deps: [DatabaseService, ProductsService] })
export class CartService {
  constructor(
    private readonly database: DatabaseService,
    private readonly products: ProductsService,
  ) {}

  async getCart(userId: string): Promise<Cart> {
    return (await this.database.getCart(userId)) ?? newCart(userId);
  }

  toView(cart: Cart): CartView {
    const pricedItems = cart.items.filter((item) => item.unitPrice !== null);
    const currencies = new Set(pricedItems.map((item) => item.currency));
    if (currencies.size > 1) {
      throw new ConflictError('Cart contains items in multiple currencies', {
        currencies: [...currencies],
      });
    }

    return {
      userId: cart.userId,
      items: cart.items,
      itemCount: cart.items.reduce((total, item) => total + item.quantity, 0),
      subtotal: addMoney(
        cart.items.map((item) =>
          item.unitPrice === null ? 0 : item.unitPrice * item.quantity,
        ),
      ),
      currency: pricedItems[0]?.currency ?? cart.items[0]?.currency ?? 'USD',
      revision: computeCartRevision(cart),
      updatedAt: cart.updatedAt,
    };
  }

  /**
   * Adds a catalog item to a cart using server-fetched product data.
   *
   * The caller supplies an item ID and a quantity only. Title, price,
   * currency, URL, and availability always come from `ProductsService`, so a
   * client cannot forge a price or add an item that does not exist. The eBay
   * lookup happens before the storage mutation so the per-user lock is held
   * only for the read-modify-write itself.
   */
  async addItem(userId: string, input: AddCartItemInput): Promise<Cart> {
    const product = await this.products.getItem(input.item_id);
    if (!product.itemId) {
      throw new NotFoundError('Product', input.item_id);
    }

    const now = new Date().toISOString();
    return this.database.mutateCart(userId, (current) => {
      const cart = current ?? newCart(userId);
      const existing = cart.items.find((item) => item.itemId === product.itemId);
      const nextQuantity = (existing?.quantity ?? 0) + input.quantity;

      if (nextQuantity > MAX_CART_ITEM_QUANTITY) {
        throw new BadRequestError(`A cart item cannot exceed quantity ${MAX_CART_ITEM_QUANTITY}`, {
          itemId: product.itemId,
          requestedQuantity: nextQuantity,
        });
      }
      if (!existing && cart.items.length >= MAX_CART_ITEMS) {
        throw new BadRequestError(`A cart cannot hold more than ${MAX_CART_ITEMS} distinct items`, {
          maximumItems: MAX_CART_ITEMS,
        });
      }
      if (
        product.availableQuantity !== null &&
        product.availableQuantity !== undefined &&
        product.availableQuantity < nextQuantity
      ) {
        throw new OutOfStockError(product.itemId, nextQuantity, product.availableQuantity);
      }

      const otherCurrency = cart.items.find(
        (item) => item.itemId !== product.itemId && item.currency !== product.currency,
      );
      if (otherCurrency) {
        throw new ConflictError('The cart already holds items in a different currency', {
          itemId: product.itemId,
          existingCurrency: otherCurrency.currency,
          incomingCurrency: product.currency,
        });
      }

      const item: CartItem = {
        itemId: product.itemId,
        title: product.title,
        quantity: nextQuantity,
        unitPrice: product.price,
        currency: product.currency,
        imageUrl: product.imageUrl,
        itemWebUrl: product.itemWebUrl,
        condition: product.condition,
        addedAt: existing?.addedAt ?? now,
        updatedAt: now,
      };

      return {
        ...cart,
        items: existing
          ? cart.items.map((candidate) => (candidate.itemId === item.itemId ? item : candidate))
          : [...cart.items, item],
        updatedAt: now,
      };
    });
  }

  async updateItem(userId: string, itemId: string, quantity: number): Promise<Cart> {
    const now = new Date().toISOString();
    return this.database.mutateCart(userId, (current) => {
      const cart = current ?? newCart(userId);
      const existing = cart.items.find((item) => item.itemId === itemId);
      if (!existing) {
        throw new NotFoundError('Cart item', itemId);
      }

      return {
        ...cart,
        items: quantity === 0
          ? cart.items.filter((item) => item.itemId !== itemId)
          : cart.items.map((item) =>
              item.itemId === itemId ? { ...item, quantity, updatedAt: now } : item,
            ),
        updatedAt: now,
      };
    });
  }

  async clearCart(userId: string): Promise<void> {
    await this.database.saveCart(newCart(userId));
  }

  static calculateLineTotal(item: CartItem): number {
    return item.unitPrice === null ? 0 : roundMoney(item.unitPrice * item.quantity);
  }
}
