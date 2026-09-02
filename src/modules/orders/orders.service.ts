import { randomUUID } from 'node:crypto';
import { Injectable, ConfigService, clearCache } from '@nitrostack/core';
import { computeCartRevision } from '../../common/cart-revision.js';
import { addMoney, roundMoney } from '../../common/money.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  OutOfStockError,
} from '../../common/errors.js';
import type {
  Cart,
  CartItem,
  CheckoutQuote,
  FulfillmentMode,
  Order,
  OrderItem,
  OrderStatus,
  ProductDetails,
  ShippingAddress,
} from '../../common/types.js';
import { DatabaseService } from '../../database/database.service.js';
import { CartService } from '../cart/cart.service.js';
import { ProductsService } from '../products/products.service.js';

export const DEFAULT_QUOTE_TTL_SECONDS = 600;
const QUOTE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function toOrderItem(cartItem: CartItem, product: ProductDetails): OrderItem {
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
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly database: DatabaseService,
    private readonly cart: CartService,
    private readonly products: ProductsService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    // Expired quotes are also pruned on every checkout; this timer keeps an
    // idle server from accumulating them indefinitely. unref() so the interval
    // never holds the process open during shutdown.
    this.cleanupTimer = setInterval(() => {
      void this.pruneExpiredQuotes().catch(() => undefined);
    }, QUOTE_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** The only implemented mode; see docs/OPERATIONS.md for the limitations. */
  getFulfillmentMode(): FulfillmentMode {
    const configured = this.config.get<string>('SHOPPING_FULFILLMENT_MODE', 'demo')?.trim().toLowerCase();
    return configured === 'external' ? 'external' : 'demo';
  }

  private getQuoteTtlSeconds(): number {
    const configured = Number(
      this.config.get<string>('SHOPPING_QUOTE_TTL_SECONDS', String(DEFAULT_QUOTE_TTL_SECONDS)),
    );
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_QUOTE_TTL_SECONDS;
  }

  private getTaxRate(): number {
    return Math.max(0, Number(this.config.get<string>('SHOPPING_TAX_RATE', '0')) || 0);
  }

  /**
   * Removes quotes whose lifetime has elapsed.
   *
   * Consumed quotes survive for a retention window so a retried `place_order`
   * still resolves to the order it produced instead of reporting a missing
   * checkout.
   */
  async pruneExpiredQuotes(now = new Date()): Promise<number> {
    return this.database.deleteExpiredQuotes(now);
  }

  private async priceCartItems(cart: Cart): Promise<{ items: OrderItem[]; products: ProductDetails[] }> {
    // Deliberately bypasses the tool-level product cache: a quote must be built
    // from prices and availability read at quote time.
    const products = await Promise.all(cart.items.map((item) => this.products.getItem(item.itemId)));
    const items = cart.items.map((item, index) => {
      const product = products[index];
      if (
        product.availableQuantity !== null &&
        product.availableQuantity !== undefined &&
        product.availableQuantity < item.quantity
      ) {
        throw new OutOfStockError(item.itemId, item.quantity, product.availableQuantity);
      }
      return toOrderItem(item, product);
    });
    return { items, products };
  }

  async createCheckout(userId: string, shippingAddress?: ShippingAddress): Promise<CheckoutQuote> {
    await this.pruneExpiredQuotes();
    const cart = await this.cart.getCart(userId);
    if (cart.items.length === 0) {
      throw new BadRequestError('Cannot checkout an empty cart');
    }

    const { items, products } = await this.priceCartItems(cart);
    const currencies = new Set(items.map((item) => item.currency));
    if (currencies.size !== 1) {
      throw new ConflictError('All items in an order must use the same currency', {
        currencies: [...currencies],
      });
    }

    const currency = items[0].currency;
    const subtotal = addMoney(items.map((item) => item.lineTotal));
    const shipping = addMoney(
      products.map((product, index) =>
        roundMoney((product.shipping?.value ?? 0) * cart.items[index].quantity),
      ),
    );
    const tax = roundMoney(subtotal * this.getTaxRate());
    const now = new Date();
    const quote: CheckoutQuote = {
      id: `chk_${randomUUID()}`,
      userId,
      status: 'active',
      items,
      subtotal,
      shipping,
      tax,
      total: addMoney([subtotal, shipping, tax]),
      currency,
      shippingAddress,
      // Binding the quote to the cart it was priced from is what stops a stale
      // quote from placing an order for goods the shopper has since changed.
      cartRevision: computeCartRevision(cart),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.getQuoteTtlSeconds() * 1000).toISOString(),
    };

    await this.database.saveQuote(quote);
    return structuredClone(quote);
  }

  /**
   * Re-reads every quoted item from eBay immediately before placement.
   *
   * The catalog is read-only through an application token, so no inventory can
   * be reserved: the price and availability a shopper confirmed can change
   * between checkout and placement. Rather than silently charging a stale
   * total, a change is reported as a conflict that requires a new quote.
   */
  private async revalidateQuote(quote: CheckoutQuote): Promise<void> {
    const products = await Promise.all(quote.items.map((item) => this.products.getItem(item.itemId)));

    const changes: Array<Record<string, unknown>> = [];
    quote.items.forEach((item, index) => {
      const product = products[index];
      if (product.currency !== item.currency || roundMoney(product.price) !== roundMoney(item.unitPrice)) {
        changes.push({
          itemId: item.itemId,
          quotedPrice: item.unitPrice,
          quotedCurrency: item.currency,
          currentPrice: roundMoney(product.price),
          currentCurrency: product.currency,
        });
      }
      if (
        product.availableQuantity !== null &&
        product.availableQuantity !== undefined &&
        product.availableQuantity < item.quantity
      ) {
        throw new OutOfStockError(item.itemId, item.quantity, product.availableQuantity);
      }
    });

    if (changes.length > 0) {
      throw new ConflictError(
        'Prices changed since this checkout quote was created; run checkout again',
        { checkoutId: quote.id, changes },
      );
    }
  }

  /**
   * Places an order from a checkout quote.
   *
   * The checkout ID is the idempotency key: retrying after a timeout returns
   * the order the first attempt created rather than placing a second one, and
   * two replicas cannot both consume the same quote because the quote is
   * transitioned to `consumed` inside the same transaction that writes the
   * order.
   */
  async placeOrder(
    userId: string,
    checkoutId: string,
    shippingAddress?: ShippingAddress,
  ): Promise<{ order: Order; alreadyPlaced: boolean }> {
    const quote = await this.database.getQuote(userId, checkoutId);
    if (!quote) {
      throw new NotFoundError('Checkout', checkoutId);
    }

    if (quote.status === 'consumed') {
      const existing = quote.placedOrderId
        ? await this.database.getOrder(userId, quote.placedOrderId)
        : null;
      if (existing) {
        return { order: existing, alreadyPlaced: true };
      }
      throw new NotFoundError('Checkout', checkoutId);
    }

    if (Date.parse(quote.expiresAt) <= Date.now()) {
      throw new ConflictError('Checkout quote has expired; run checkout again', { checkoutId });
    }

    await this.revalidateQuote(quote);

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
      quoteId: quote.id,
      fulfillment: this.getFulfillmentMode(),
      createdAt: now,
      updatedAt: now,
    };

    const result = await this.database.placeOrderFromQuote({
      quoteId: quote.id,
      userId,
      order,
      expectedCartRevision: quote.cartRevision,
    });

    switch (result.outcome) {
      case 'placed':
        await clearCache();
        return { order: structuredClone(result.order), alreadyPlaced: false };
      case 'already_placed':
        return { order: structuredClone(result.order), alreadyPlaced: true };
      case 'expired':
        throw new ConflictError('Checkout quote has expired; run checkout again', { checkoutId });
      case 'cart_changed':
        // The newer cart is deliberately left untouched.
        throw new ConflictError(
          'The cart changed after this checkout quote was created; run checkout again',
          {
            checkoutId,
            quotedCartRevision: quote.cartRevision,
            currentCartRevision: result.currentRevision,
          },
        );
      default:
        throw new NotFoundError('Checkout', checkoutId);
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

  /**
   * Cancels an order.
   *
   * In `demo` fulfilment nothing has been paid, reserved, or shipped, so any
   * order that is not already cancelled is eligible. A real fulfilment
   * integration would have to consult shipment state and issue a refund here.
   */
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
