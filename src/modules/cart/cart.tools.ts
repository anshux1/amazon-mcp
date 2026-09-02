import {
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
import { CartViewOutputSchema, standardOutput } from '../../common/output-schema.js';
import { ShoppingExceptionFilter } from '../../common/pipeline/exception.filter.js';
import { LoggingMiddleware } from '../../common/pipeline/logging.middleware.js';
import { NormalizeInputPipe } from '../../common/pipeline/normalize-input.pipe.js';
import { ResponseTransformInterceptor } from '../../common/pipeline/response.interceptor.js';
import { EBAY_IMAGE_CSP } from '../../config/widget-csp.js';
import { AuthService } from '../auth/auth.service.js';
import { JWTGuard } from '../auth/jwt.guard.js';
import { ScopeGuard } from '../auth/scope.guard.js';
import { CartService, MAX_CART_ITEM_QUANTITY } from './cart.service.js';

/**
 * Only an item ID and a quantity are accepted. Titles, prices, currencies, and
 * URLs are always fetched from the catalog by the server, so a client cannot
 * put a forged price into a cart or a checkout quote.
 */
const AddToCartSchema = z.object({
  item_id: z.string().min(1).max(200).describe('eBay item ID from search_products or get_product'),
  quantity: z.number().int().min(1).max(MAX_CART_ITEM_QUANTITY).describe('Number of units to add'),
});

const EmptyInputSchema = z.object({});

const UpdateCartItemSchema = z.object({
  item_id: z.string().min(1).max(200).describe('eBay item ID already in the cart'),
  quantity: z.number().int().min(0).max(MAX_CART_ITEM_QUANTITY).describe('New quantity; 0 removes the item'),
});

const CartOutputSchema = standardOutput(CartViewOutputSchema);

@Injectable({ deps: [CartService, AuthService] })
export class CartTools {
  constructor(
    private readonly cart: CartService,
    private readonly auth: AuthService,
  ) {}

  @Tool({
    name: 'add_to_cart',
    title: 'Add to cart',
    description:
      'Add a catalog item to the authenticated user cart. Only item_id and quantity are accepted: the title, price, currency, and availability are fetched from eBay by the server. Never pass a user ID; it comes from the JWT subject.',
    inputSchema: AddToCartSchema,
    outputSchema: CartOutputSchema,
    examples: {
      request: { item_id: 'v1|123|0', quantity: 2 },
      response: { success: true, data: { itemCount: 2, subtotal: 159.98, currency: 'USD' } },
    },
  })
  @UseGuards(JWTGuard, ScopeGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget({ route: 'cart-summary', csp: EBAY_IMAGE_CSP })
  async addToCart(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(AddToCartSchema, input);
    const userId = this.auth.getUserId(ctx);
    const cart = await this.cart.addItem(userId, value);
    return this.cart.toView(cart);
  }

  @Tool({
    name: 'view_cart',
    title: 'View cart',
    description: 'View the authenticated user cart and its current item subtotal.',
    inputSchema: EmptyInputSchema,
    outputSchema: CartOutputSchema,
    examples: {
      request: {},
      response: { success: true, data: { itemCount: 0, subtotal: 0, currency: 'USD', items: [] } },
    },
  })
  @UseGuards(JWTGuard, ScopeGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget({ route: 'cart-summary', csp: EBAY_IMAGE_CSP })
  async viewCart(input: unknown, ctx: ExecutionContext) {
    parseInput(EmptyInputSchema, input);
    const userId = this.auth.getUserId(ctx);
    return this.cart.toView(await this.cart.getCart(userId));
  }

  @Tool({
    name: 'update_cart_item',
    title: 'Update cart item',
    description: 'Set an item quantity in the authenticated user cart; quantity 0 removes it.',
    inputSchema: UpdateCartItemSchema,
    outputSchema: CartOutputSchema,
    examples: {
      request: { item_id: 'v1|123|0', quantity: 3 },
      response: { success: true, data: { itemCount: 3, subtotal: 239.97, currency: 'USD' } },
    },
  })
  @UseGuards(JWTGuard, ScopeGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget({ route: 'cart-summary', csp: EBAY_IMAGE_CSP })
  async updateCartItem(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(UpdateCartItemSchema, input);
    const userId = this.auth.getUserId(ctx);
    const cart = await this.cart.updateItem(userId, value.item_id, value.quantity);
    return this.cart.toView(cart);
  }
}

export { AddToCartSchema, EmptyInputSchema, UpdateCartItemSchema };
