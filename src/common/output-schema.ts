import { z } from '@nitrostack/core';

/**
 * The failure half of the standard tool envelope produced by
 * ShoppingExceptionFilter. Every tool can return this shape, so it is part of
 * each tool's advertised output contract.
 */
export const ErrorEnvelopeSchema = z.object({
  success: z.literal(false),
  data: z.null(),
  error: z.object({
    code: z.string().describe('Stable error code, for example NOT_FOUND or CONFLICT'),
    message: z.string(),
    statusCode: z.number().int(),
    details: z.unknown().optional(),
  }),
  timestamp: z.string(),
  requestId: z.string(),
  tool: z.string().optional(),
});

/**
 * Wraps a tool's payload schema in the standard response envelope added by
 * ResponseTransformInterceptor, so `structuredContent` validates against the
 * advertised `outputSchema` for both success and failure.
 */
export function standardOutput<T extends z.ZodTypeAny>(data: T) {
  return z.union([
    z.object({
      success: z.literal(true),
      data,
      timestamp: z.string(),
      requestId: z.string(),
    }),
    ErrorEnvelopeSchema,
  ]);
}

export const MoneySchema = z.number().describe('Amount in the response currency');

export const CartItemOutputSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  quantity: z.number().int(),
  unitPrice: z.number().nullable(),
  currency: z.string(),
  imageUrl: z.string().optional(),
  itemWebUrl: z.string().optional(),
  condition: z.string().optional(),
  addedAt: z.string(),
  updatedAt: z.string(),
});

export const OrderItemOutputSchema = CartItemOutputSchema.extend({
  unitPrice: z.number(),
  lineTotal: z.number(),
});

export const ShippingAddressOutputSchema = z.object({
  recipientName: z.string(),
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  stateOrProvince: z.string().optional(),
  postalCode: z.string(),
  country: z.string(),
});

export const CartViewOutputSchema = z.object({
  userId: z.string(),
  items: z.array(CartItemOutputSchema),
  itemCount: z.number().int(),
  subtotal: MoneySchema,
  currency: z.string(),
  revision: z.string().describe('Cart fingerprint; a checkout quote is bound to this value'),
  updatedAt: z.string(),
});

export const OrderOutputSchema = z.object({
  orderId: z.string(),
  status: z.enum(['placed', 'cancelled']),
  items: z.array(OrderItemOutputSchema),
  subtotal: MoneySchema,
  shipping: MoneySchema,
  tax: MoneySchema,
  total: MoneySchema,
  currency: z.string(),
  fulfillment: z.enum(['demo', 'external']).describe('demo orders are recorded locally and are never fulfilled'),
  quoteId: z.string().optional(),
  shippingAddress: ShippingAddressOutputSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().optional(),
});

export const CheckoutQuoteOutputSchema = z.object({
  checkoutId: z.string(),
  itemCount: z.number().int(),
  items: z.array(OrderItemOutputSchema),
  subtotal: MoneySchema,
  shipping: MoneySchema,
  tax: MoneySchema,
  total: MoneySchema,
  currency: z.string(),
  cartRevision: z.string(),
  shippingAddress: ShippingAddressOutputSchema.optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const ProductSummaryOutputSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  price: z.number(),
  currency: z.string(),
  imageUrl: z.string().optional(),
  itemWebUrl: z.string().optional(),
  condition: z.string().optional(),
  categoryId: z.string().optional(),
  availableQuantity: z.number().nullable().optional(),
  seller: z
    .object({
      username: z.string().optional(),
      feedbackPercentage: z.number().optional(),
    })
    .optional(),
});

export const ProductDetailsOutputSchema = ProductSummaryOutputSchema.extend({
  description: z.string().optional(),
  additionalImageUrls: z.array(z.string()),
  shipping: z.object({ value: z.number(), currency: z.string() }).optional(),
  location: z.string().optional(),
  buyingOptions: z.array(z.string()),
  lastUpdated: z.string(),
});

export const SearchResultOutputSchema = z.object({
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  items: z.array(ProductSummaryOutputSchema),
  source: z.enum(['ebay', 'demo']),
});

const CategoryNodeBase = z.object({
  categoryId: z.string(),
  categoryName: z.string(),
});

export type CategoryNodeOutput = z.infer<typeof CategoryNodeBase> & {
  children: CategoryNodeOutput[];
};

export const CategoryNodeOutputSchema: z.ZodType<CategoryNodeOutput> = CategoryNodeBase.extend({
  children: z.lazy(() => z.array(CategoryNodeOutputSchema)),
});

export const CategoryTreeOutputSchema = z.object({
  treeId: z.string(),
  root: CategoryNodeOutputSchema,
  truncated: z.boolean().optional().describe('True when deep branches were omitted to bound the response size'),
  depth: z.number().int().optional(),
});
