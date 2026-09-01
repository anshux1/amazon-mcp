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
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
}

export interface CheckoutQuote {
  id: string;
  userId: string;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  currency: CurrencyCode;
  shippingAddress?: ShippingAddress;
  createdAt: string;
  expiresAt: string;
}

export interface DatabaseState {
  version: 1;
  carts: Record<string, Cart>;
  orders: Record<string, Order>;
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
