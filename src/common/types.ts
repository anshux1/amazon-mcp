export type CurrencyCode = string;

export interface Money {
  value: number;
  currency: CurrencyCode;
}

export interface ProductSummary {
  itemId: string;
  title: string;
  price: number;
  currency: CurrencyCode;
  imageUrl?: string;
  itemWebUrl?: string;
  condition?: string;
  categoryId?: string;
  seller?: {
    username?: string;
    feedbackPercentage?: number;
  };
  availableQuantity?: number | null;
}

export interface ProductDetails extends ProductSummary {
  description?: string;
  additionalImageUrls: string[];
  shipping?: Money;
  location?: string;
  buyingOptions: string[];
  lastUpdated: string;
}

export interface CategoryNode {
  categoryId: string;
  categoryName: string;
  children: CategoryNode[];
}

export interface CartItem {
  itemId: string;
  title: string;
  quantity: number;
  unitPrice: number | null;
  currency: CurrencyCode;
  imageUrl?: string;
  itemWebUrl?: string;
  condition?: string;
  addedAt: string;
  updatedAt: string;
}

export interface Cart {
  userId: string;
  items: CartItem[];
  updatedAt: string;
}

export interface ShippingAddress {
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  stateOrProvince?: string;
  postalCode: string;
  country: string;
}

export interface OrderItem extends CartItem {
  unitPrice: number;
  lineTotal: number;
}

export type OrderStatus = 'placed' | 'cancelled';

/**
 * Fulfilment modes this server implements.
 *
 * `demo` records orders in this server's own database only: there is no
 * payment authorization, no inventory reservation, and no eBay order or
 * fulfilment integration. It is the only implemented mode; `external` is
 * rejected at startup so a deployment cannot silently pretend to be a real
 * commerce backend.
 */
export type FulfillmentMode = 'demo' | 'external';

export interface Order {
  id: string;
  userId: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  currency: CurrencyCode;
  shippingAddress?: ShippingAddress;
  /** The checkout quote this order was placed from; also its idempotency key. */
  quoteId?: string;
  fulfillment: FulfillmentMode;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
}

/**
 * `active` quotes may still be placed. `consumed` quotes already produced
 * `placedOrderId` and exist so a retried `place_order` is idempotent instead
 * of creating a second order.
 */
export type CheckoutQuoteStatus = 'active' | 'consumed';

export interface CheckoutQuote {
  id: string;
  userId: string;
  status: CheckoutQuoteStatus;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  currency: CurrencyCode;
  shippingAddress?: ShippingAddress;
  /** The cart fingerprint this quote was produced from; see computeCartRevision. */
  cartRevision: string;
  placedOrderId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface DatabaseState {
  version: 2;
  carts: Record<string, Cart>;
  orders: Record<string, Order>;
  quotes: Record<string, CheckoutQuote>;
}

export interface StandardSuccess<T> {
  success: true;
  data: T;
  timestamp: string;
  requestId: string;
}

export interface StandardFailure {
  success: false;
  data: null;
  error: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
  };
  timestamp: string;
  requestId: string;
  tool?: string;
}

export type StandardResponse<T> = StandardSuccess<T> | StandardFailure;
