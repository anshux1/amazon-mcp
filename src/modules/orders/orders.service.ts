import { randomUUID } from 'node:crypto';
import { Injectable, ConfigService } from '@nitrostack/core';
import { clearCache } from '@nitrostack/core';
import { addMoney, roundMoney } from '../../common/money.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  OutOfStockError,
} from '../../common/errors.js';
import type {
  CartItem,
  CheckoutQuote,
  Order,
  OrderItem,
  OrderStatus,
  ShippingAddress,
} from '../../common/types.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import { CartService } from '../cart/cart.service.js';
import { ProductsService } from '../products/products.service.js';

function toOrderItem(cartItem: CartItem, product: Awaited<ReturnType<ProductsService['getItem']>>): OrderItem {
  return {
    itemId: product.itemId,
    title: product.title,
    quantity: cartItem.quantity,
    unitPrice: product.price,
    currency: product.currency,
    lineTotal: roundMoney(product.price * cartItem.quantity),
    imageUrl: product.imageUrl,
    itemWebUrl: product.itemWebUrl,
    condition: product.condition,
    addedAt: cartItem.addedAt,
    updatedAt: new Date().toISOString(),
  };
}

@Injectable({ deps: [DatabaseService, CartService, ProductsService, ConfigService] })
export class OrdersService {
  private readonly quotes = new Map<string, CheckoutQuote>();
  private readonly placingQuotes = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly cart: CartService,
    private readonly products: ProductsService,
    private readonly config: ConfigService,
  ) {}

  private pruneExpiredQuotes(): void {
    const now = Date.now();
    for (const [checkoutId, quote] of this.quotes) {
      if (Date.parse(quote.expiresAt) <= now && !this.placingQuotes.has(checkoutId)) {
        this.quotes.delete(checkoutId);
      }
    }
  }

  async createCheckout(userId: string, shippingAddress?: ShippingAddress): Promise<CheckoutQuote> {
    this.pruneExpiredQuotes();
    const cart = await this.cart.getCart(userId);
    if (cart.items.length === 0) {
      throw new BadRequestError('Cannot checkout an empty cart');
    }

    // Deliberately bypasses the product cache: checkout must verify live prices
    // and availability immediately before an order is placed.
    const freshProducts = await Promise.all(
      cart.items.map((item) => this.products.getItem(item.itemId)),
    );
    const items = cart.items.map((item, index) => {
      const product = freshProducts[index];
      if (
        product.availableQuantity !== null &&
        product.availableQuantity !== undefined &&
        product.availableQuantity < item.quantity
      ) {
        throw new OutOfStockError(item.itemId, item.quantity, product.availableQuantity);
      }
      return toOrderItem(item, product);
    });

    const currencies = new Set(items.map((item) => item.currency));
    if (currencies.size !== 1) {
      throw new ConflictError('All items in an order must use the same currency', {
        currencies: [...currencies],
      });
    }

    const currency = items[0].currency;
    const subtotal = addMoney(items.map((item) => item.lineTotal));
    const shipping = addMoney(
      freshProducts.map((product, index) =>
        roundMoney((product.shipping?.value ?? 0) * cart.items[index].quantity),
      ),
    );
    const taxRate = Math.max(0, Number(this.config.get<string>('SHOPPING_TAX_RATE', '0')) || 0);
    const tax = roundMoney(subtotal * taxRate);
    const now = new Date();
    const quote: CheckoutQuote = {
      id: `chk_${randomUUID()}`,
      userId,
      items,
      subtotal,
      shipping,
      tax,
      total: addMoney([subtotal, shipping, tax]),
      currency,
      shippingAddress,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    };

    this.quotes.set(quote.id, quote);
    return structuredClone(quote);
  }

  async placeOrder(
    userId: string,
    checkoutId: string,
    shippingAddress?: ShippingAddress,
  ): Promise<Order> {
    const quote = this.quotes.get(checkoutId);
    if (!quote || quote.userId !== userId) {
      throw new NotFoundError('Checkout', checkoutId);
    }
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      this.quotes.delete(checkoutId);
      throw new ConflictError('Checkout quote has expired; run checkout again', {
        checkoutId,
      });
    }
    if (this.placingQuotes.has(checkoutId)) {
      throw new ConflictError('Checkout quote is already being placed', { checkoutId });
    }

    this.placingQuotes.add(checkoutId);
    try {
      const now = new Date().toISOString();
      const order: Order = {
        id: `ord_${randomUUID()}`,
        userId,
        status: 'placed',
        items: structuredClone(quote.items),
        subtotal: quote.subtotal,
        shipping: quote.shipping,
        tax: quote.tax,
        total: quote.total,
        currency: quote.currency,
        shippingAddress: shippingAddress ?? quote.shippingAddress,
        createdAt: now,
        updatedAt: now,
      };

      await this.database.saveOrderAndClearCart(order);
      this.quotes.delete(checkoutId);
      await clearCache();
      return structuredClone(order);
    } finally {
      this.placingQuotes.delete(checkoutId);
    }
  }

  async getOrder(userId: string, orderId: string): Promise<Order> {
    const order = await this.database.getOrder(userId, orderId);
    if (!order) {
      throw new NotFoundError('Order', orderId);
    }
    return order;
  }

  async getOrderHistory(
    userId: string,
    status?: OrderStatus,
    limit = 20,
  ): Promise<Order[]> {
    const orders = await this.database.listOrders(userId);
    return orders
      .filter((order) => !status || order.status === status)
      .slice(0, limit);
  }

  async cancelOrder(userId: string, orderId: string): Promise<Order> {
    const order = await this.getOrder(userId, orderId);
    if (order.status === 'cancelled') {
      throw new ConflictError('Order is already cancelled', { orderId });
    }

    const now = new Date().toISOString();
    const cancelled: Order = {
      ...order,
      status: 'cancelled',
      cancelledAt: now,
      updatedAt: now,
    };
    await this.database.saveOrder(cancelled);
    await clearCache();
    return cancelled;
  }
}
