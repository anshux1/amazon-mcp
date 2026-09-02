import {
  Cache,
  ExecutionContext,
  ToolDecorator as Tool,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UseMiddleware,
  UsePipes,
  Widget,
  z,
  Injectable,
} from '@nitrostack/core';
import { parseInput } from '../../common/validation.js';
import {
  CheckoutQuoteOutputSchema,
  OrderOutputSchema,
  standardOutput,
} from '../../common/output-schema.js';
import { EBAY_IMAGE_CSP } from '../../config/widget-csp.js';
import { ShoppingExceptionFilter } from '../../common/pipeline/exception.filter.js';
import { LoggingMiddleware } from '../../common/pipeline/logging.middleware.js';
import { NormalizeInputPipe } from '../../common/pipeline/normalize-input.pipe.js';
import { ResponseTransformInterceptor } from '../../common/pipeline/response.interceptor.js';
import type { Order, OrderStatus, ShippingAddress } from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import { JWTGuard } from '../auth/jwt.guard.js';
import { ScopeGuard } from '../auth/scope.guard.js';
import { OrdersService } from './orders.service.js';

const ShippingAddressSchema = z.object({
  recipient_name: z.string().min(1).max(200),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state_or_province: z.string().max(100).optional(),
  postal_code: z.string().min(1).max(30),
  country: z.string().length(2).transform((value) => value.toUpperCase()),
});

type ShippingAddressInput = z.infer<typeof ShippingAddressSchema>;

function toShippingAddress(input: ShippingAddressInput): ShippingAddress {
  return {
    recipientName: input.recipient_name,
    line1: input.line1,
    line2: input.line2,
    city: input.city,
    stateOrProvince: input.state_or_province,
    postalCode: input.postal_code,
    country: input.country,
  };
}

const CheckoutSchema = z.object({
  shipping_address: ShippingAddressSchema.optional().describe('Optional address used to calculate the checkout quote'),
});

const PlaceOrderSchema = z.object({
  checkout_id: z.string().min(1).max(200).describe('Checkout ID returned by checkout'),
  shipping_address: ShippingAddressSchema.optional().describe('Optional address to save on the order'),
});

const GetOrderSchema = z.object({
  order_id: z.string().min(1).max(200).describe('Order ID returned by place_order'),
});

const OrderHistorySchema = z.object({
  status: z.enum(['placed', 'cancelled']).optional().describe('Optional status filter'),
  limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of orders to return'),
});

type OrderHistoryInput = z.infer<typeof OrderHistorySchema>;

const CancelOrderSchema = z.object({
  order_id: z.string().min(1).max(200).describe('Order ID to cancel'),
});

function orderView(order: Order) {
  return {
    orderId: order.id,
    status: order.status,
    items: order.items,
    subtotal: order.subtotal,
    shipping: order.shipping,
    tax: order.tax,
    total: order.total,
    currency: order.currency,
    fulfillment: order.fulfillment,
    quoteId: order.quoteId,
    shippingAddress: order.shippingAddress,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt,
  };
}

function quoteView(quote: Awaited<ReturnType<OrdersService['createCheckout']>>) {
  return {
    checkoutId: quote.id,
    itemCount: quote.items.reduce((count, item) => count + item.quantity, 0),
    items: quote.items,
    subtotal: quote.subtotal,
    shipping: quote.shipping,
    tax: quote.tax,
    total: quote.total,
    currency: quote.currency,
    cartRevision: quote.cartRevision,
    shippingAddress: quote.shippingAddress,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
  };
}

const PlaceOrderOutputSchema = standardOutput(
  z.object({
    order: OrderOutputSchema,
    alreadyPlaced: z.boolean().describe('True when a retry resolved to the order the quote already produced'),
    message: z.string(),
  }),
);
const CancelOrderOutputSchema = standardOutput(
  z.object({
    orderId: z.string(),
    status: z.enum(['placed', 'cancelled']),
    cancelledAt: z.string().optional(),
    message: z.string(),
  }),
);
const OrderHistoryOutputSchema = standardOutput(
  z.object({ count: z.number().int(), orders: z.array(OrderOutputSchema) }),
);

@Injectable({ deps: [OrdersService, AuthService] })
export class OrdersTools {
  constructor(
    private readonly orders: OrdersService,
    private readonly auth: AuthService,
  ) {}

  @Tool({
    name: 'checkout',
    title: 'Preview checkout',
    description:
      'Create a short-lived checkout quote using live eBay prices and availability. This does not place an order. The quote is bound to the cart it was priced from, so changing the cart afterwards requires a new quote.',
    inputSchema: CheckoutSchema,
    outputSchema: standardOutput(CheckoutQuoteOutputSchema),
    examples: {
      request: { shipping_address: { recipient_name: 'Ada Lovelace', line1: '1 Main St', city: 'London', postal_code: 'N1', country: 'GB' } },
      response: { success: true, data: { checkoutId: 'chk_...', subtotal: 79.99, shipping: 0, tax: 0, total: 79.99, currency: 'USD', expiresAt: '2025-01-01T00:10:00.000Z' } },
    },
  })
  @UseGuards(JWTGuard, ScopeGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget({ route: 'cart-summary', csp: EBAY_IMAGE_CSP })
  async checkout(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(CheckoutSchema, input);
    const userId = this.auth.getUserId(ctx);
    const address = value.shipping_address ? toShippingAddress(value.shipping_address) : undefined;
    return quoteView(await this.orders.createCheckout(userId, address));
  }

  @Tool({
    name: 'place_order',
    title: 'Place order',
    description:
      'Place an authenticated user order from an unexpired checkout quote and clear the cart. Prices and availability are re-checked first. Safe to retry with the same checkout_id: it returns the order the first attempt created instead of placing a second one.',
    inputSchema: PlaceOrderSchema,
    outputSchema: PlaceOrderOutputSchema,
    examples: {
      request: { checkout_id: 'chk_123' },
      response: { success: true, data: { orderId: 'ord_123', status: 'placed', total: 79.99, currency: 'USD', items: [] } },
    },
  })
  @UseGuards(JWTGuard, ScopeGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget({ route: 'order-confirmation', csp: EBAY_IMAGE_CSP })
  async placeOrder(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(PlaceOrderSchema, input);
    const userId = this.auth.getUserId(ctx);
    const address = value.shipping_address ? toShippingAddress(value.shipping_address) : undefined;
    const { order, alreadyPlaced } = await this.orders.placeOrder(userId, value.checkout_id, address);
    return {
      order: orderView(order),
      alreadyPlaced,
      message: alreadyPlaced
        ? 'This checkout was already placed; returning the existing order.'
        : 'Order placed successfully.',
    };
  }

  @Tool({
    name: 'get_order',
    title: 'Get order',
    description: 'Retrieve one order belonging to the authenticated user.',
    inputSchema: GetOrderSchema,
    outputSchema: standardOutput(OrderOutputSchema),
    examples: {
      request: { order_id: 'ord_123' },
      response: { success: true, data: { orderId: 'ord_123', status: 'placed', items: [], total: 79.99, currency: 'USD' } },
    },
  })
  @UseGuards(JWTGuard, ScopeGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget({ route: 'order-summary', csp: EBAY_IMAGE_CSP })
  async getOrder(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(GetOrderSchema, input);
    const userId = this.auth.getUserId(ctx);
    return orderView(await this.orders.getOrder(userId, value.order_id));
  }

  @Tool({
    name: 'order_history',
    title: 'Order history',
    description: 'List orders belonging only to the authenticated user, newest first.',
    inputSchema: OrderHistorySchema,
    outputSchema: OrderHistoryOutputSchema,
    examples: {
      request: { limit: 10 },
      response: { success: true, data: { count: 1, orders: [{ orderId: 'ord_123', status: 'placed', total: 79.99, currency: 'USD' }] } },
    },
  })
  @Cache({
    ttl: 30,
    key: (input: unknown, context: unknown) => {
      const value = input as OrderHistoryInput;
      const userId = (context as ExecutionContext | undefined)?.auth?.subject ?? 'anonymous';
      return `orders:history:${userId}:${value.status ?? 'all'}:${value.limit ?? 20}`;
    },
  })
  @UseGuards(JWTGuard, ScopeGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget({ route: 'order-summary', csp: EBAY_IMAGE_CSP })
  async orderHistory(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(OrderHistorySchema, input);
    const userId = this.auth.getUserId(ctx);
    const orders = await this.orders.getOrderHistory(userId, value.status as OrderStatus | undefined, value.limit);
    return {
      count: orders.length,
      orders: orders.map(orderView),
    };
  }

  @Tool({
    name: 'cancel_order',
    title: 'Cancel order',
    description: 'Cancel an order belonging to the authenticated user when it has not already been cancelled.',
    inputSchema: CancelOrderSchema,
    outputSchema: CancelOrderOutputSchema,
    examples: {
      request: { order_id: 'ord_123' },
      response: { success: true, data: { orderId: 'ord_123', status: 'cancelled', message: 'Order cancelled successfully.' } },
    },
  })
  @UseGuards(JWTGuard, ScopeGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget('order-cancellation')
  async cancelOrder(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(CancelOrderSchema, input);
    const userId = this.auth.getUserId(ctx);
    const order = await this.orders.cancelOrder(userId, value.order_id);
    return {
      orderId: order.id,
      status: order.status,
      cancelledAt: order.cancelledAt,
      message: 'Order cancelled successfully.',
    };
  }
}

export {
  CancelOrderSchema,
  CheckoutSchema,
  GetOrderSchema,
  OrderHistorySchema,
  PlaceOrderSchema,
  ShippingAddressSchema,
};
