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
import { ShoppingExceptionFilter } from '../../common/pipeline/exception.filter.js';
import { LoggingMiddleware } from '../../common/pipeline/logging.middleware.js';
import { NormalizeInputPipe } from '../../common/pipeline/normalize-input.pipe.js';
import { ResponseTransformInterceptor } from '../../common/pipeline/response.interceptor.js';
import { AuthService } from '../auth/auth.service.js';
import { JWTGuard } from '../auth/jwt.guard.js';
import { CartService } from './cart.service.js';

const AddToCartSchema = z.object({
  item_id: z.string().min(1).max(200).describe('eBay item ID from get_product'),
  quantity: z.number().int().min(1).max(99).describe('Number of units to add'),
  title: z.string().min(1).max(500).optional().describe('Optional title snapshot from get_product'),
  unit_price: z.number().finite().nonnegative().optional().describe('Optional displayed price snapshot'),
  currency: z.string().length(3).optional().describe('Optional ISO currency code'),
  image_url: z.string().url().max(2000).optional().describe('Optional product image URL'),
  item_web_url: z.string().url().max(2000).optional().describe('Optional eBay item URL'),
  condition: z.string().max(100).optional().describe('Optional item condition'),
});

type AddToCartInput = z.infer<typeof AddToCartSchema>;

const EmptyInputSchema = z.object({});

const UpdateCartItemSchema = z.object({
  item_id: z.string().min(1).max(200).describe('eBay item ID already in the cart'),
  quantity: z.number().int().min(0).max(99).describe('New quantity; 0 removes the item'),
});

@Injectable({ deps: [CartService, AuthService] })
export class CartTools {
  constructor(
    private readonly cart: CartService,
    private readonly auth: AuthService,
  ) {}

  @Tool({
    name: 'add_to_cart',
    title: 'Add to cart',
    description: 'Add a product to the authenticated user cart. Never pass a user ID; it comes from the JWT subject.',
    inputSchema: AddToCartSchema,
    examples: {
      request: { item_id: 'v1|123|0', quantity: 2, title: 'Wireless Headphones', unit_price: 79.99, currency: 'USD' },
      response: { success: true, data: { itemCount: 2, subtotal: 159.98, currency: 'USD' } },
    },
  })
  @UseGuards(JWTGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget('cart-summary')
  async addToCart(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(AddToCartSchema, input);
    const userId = this.auth.getUserId(ctx);
    const cart = await this.cart.addItem(userId, value as AddToCartInput);
    return this.cart.toView(cart);
  }

  @Tool({
    name: 'view_cart',
    title: 'View cart',
    description: 'View the authenticated user cart and its current item subtotal.',
    inputSchema: EmptyInputSchema,
    examples: {
      request: {},
      response: { success: true, data: { itemCount: 0, subtotal: 0, currency: 'USD', items: [] } },
    },
  })
  @UseGuards(JWTGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget('cart-summary')
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
    examples: {
      request: { item_id: 'v1|123|0', quantity: 3 },
      response: { success: true, data: { itemCount: 3, subtotal: 239.97, currency: 'USD' } },
    },
  })
  @UseGuards(JWTGuard)
  @UseMiddleware(LoggingMiddleware)
  @UseInterceptors(ResponseTransformInterceptor)
  @UseFilters(ShoppingExceptionFilter)
  @UsePipes(NormalizeInputPipe)
  @Widget('cart-summary')
  async updateCartItem(input: unknown, ctx: ExecutionContext) {
    const value = parseInput(UpdateCartItemSchema, input);
    const userId = this.auth.getUserId(ctx);
    const cart = await this.cart.updateItem(userId, value.item_id, value.quantity);
    return this.cart.toView(cart);
  }
}

export { AddToCartSchema, EmptyInputSchema, UpdateCartItemSchema };
