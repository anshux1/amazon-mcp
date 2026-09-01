import { Injectable } from '@nitrostack/core';
import { addMoney, roundMoney } from '../../common/money.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors.js';
import type { Cart, CartItem } from '../../common/types.js';
import { DatabaseService } from '../../database/database.service.js';

export interface AddCartItemInput {
  item_id: string;
  quantity: number;
  title?: string;
  unit_price?: number;
  currency?: string;
  image_url?: string;
  item_web_url?: string;
  condition?: string;
}

export interface CartView {
  userId: string;
  items: CartItem[];
  itemCount: number;
  subtotal: number;
  currency: string;
  updatedAt: string;
}

function newCart(userId: string): Cart {
  return { userId, items: [], updatedAt: new Date().toISOString() };
}

@Injectable({ deps: [DatabaseService] })
export class CartService {
  constructor(private readonly database: DatabaseService) {}

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
      updatedAt: cart.updatedAt,
    };
  }

  async addItem(userId: string, input: AddCartItemInput): Promise<Cart> {
    const cart = await this.getCart(userId);
    const now = new Date().toISOString();
    const existing = cart.items.find((item) => item.itemId === input.item_id);
    const nextQuantity = (existing?.quantity ?? 0) + input.quantity;
    if (nextQuantity > 99) {
      throw new BadRequestError('A cart item cannot exceed quantity 99', {
        itemId: input.item_id,
        requestedQuantity: nextQuantity,
      });
    }

    const incomingCurrency = input.currency?.toUpperCase() ?? existing?.currency ?? 'USD';
    const existingCurrency = existing?.currency;
    if (existingCurrency && existingCurrency !== incomingCurrency) {
      throw new ConflictError('The existing cart item uses a different currency', {
        itemId: input.item_id,
        existingCurrency,
        incomingCurrency,
      });
    }

    const item: CartItem = {
      itemId: input.item_id,
      title: input.title?.trim() || existing?.title || input.item_id,
      quantity: nextQuantity,
      unitPrice: input.unit_price ?? existing?.unitPrice ?? null,
      currency: incomingCurrency,
      imageUrl: input.image_url ?? existing?.imageUrl,
      itemWebUrl: input.item_web_url ?? existing?.itemWebUrl,
      condition: input.condition ?? existing?.condition,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
    };

    cart.items = existing
      ? cart.items.map((candidate) => candidate.itemId === item.itemId ? item : candidate)
      : [...cart.items, item];
    cart.updatedAt = now;
    await this.database.saveCart(cart);
    return cart;
  }

  async updateItem(userId: string, itemId: string, quantity: number): Promise<Cart> {
    const cart = await this.getCart(userId);
    const existing = cart.items.find((item) => item.itemId === itemId);
    if (!existing) {
      throw new NotFoundError('Cart item', itemId);
    }

    const now = new Date().toISOString();
    cart.items = quantity === 0
      ? cart.items.filter((item) => item.itemId !== itemId)
      : cart.items.map((item) =>
          item.itemId === itemId ? { ...item, quantity, updatedAt: now } : item,
        );
    cart.updatedAt = now;
    await this.database.saveCart(cart);
    return cart;
  }

  async clearCart(userId: string): Promise<void> {
    await this.database.saveCart(newCart(userId));
  }

  static calculateLineTotal(item: CartItem): number {
    return item.unitPrice === null ? 0 : roundMoney(item.unitPrice * item.quantity);
  }
}
