'use client';

import { useWidgetSDK } from '@nitrostack/widgets';
import {
  ActionButton,
  ActionFeedback,
  Card,
  ConfirmButton,
  Empty,
  Failure,
  Loading,
  StatusBadge,
  Thumb,
  errorOf,
  money,
  unwrap,
  useToolActions,
  type ToolEnvelope,
} from '../../lib/ui';

interface OrderItem {
  itemId: string;
  title: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  currency: string;
  imageUrl?: string;
}

interface Order {
  orderId: string;
  status: string;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  currency: string;
  fulfillment?: string;
  shippingAddress?: {
    recipientName: string;
    line1: string;
    line2?: string;
    city: string;
    stateOrProvince?: string;
    postalCode: string;
    country: string;
  };
  createdAt?: string;
}

interface Confirmation {
  order: Order;
  alreadyPlaced?: boolean;
  message?: string;
}

export default function OrderConfirmation() {
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<Confirmation | ToolEnvelope<Confirmation>>();
  const data = unwrap(output);
  const failure = errorOf(output);
  const actions = useToolActions();

  if (!isReady) return <Loading label="Placing your order…" />;
  if (failure) return <Failure error={failure} />;
  if (!data?.order) return <Empty mark="📦" title="No order confirmation" hint="Ask the assistant to place your order." />;

  const { order } = data;
  const address = order.shippingAddress;

  return (
    <Card>
      <div className="stack">
        <div className="header">
          <div className="grow">
            <p className="eyebrow">{data.alreadyPlaced ? 'Already placed' : 'Order confirmed'}</p>
            <h2 className="title-lg">
              {data.alreadyPlaced ? 'This order was already placed' : 'Thanks for your order'}
            </h2>
          </div>
          <StatusBadge status={order.status} />
        </div>

        <div className={`notice ${data.alreadyPlaced ? 'notice-info' : 'notice-success'}`}>
          <span aria-hidden>{data.alreadyPlaced ? 'ℹ' : '✓'}</span>
          <span>
            {data.alreadyPlaced
              ? 'Your retry resolved to the existing order rather than creating a second one.'
              : data.message ?? 'Your order has been recorded.'}
          </span>
        </div>

        <ul className="list">
          {order.items.map((item) => (
            <li className="item" key={item.itemId}>
              <Thumb src={item.imageUrl} alt={item.title} size={48} />
              <div className="grow">
                <p className="clamp-2" style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</p>
                <p className="faint">
                  {money(item.unitPrice, item.currency)} × {item.quantity}
                </p>
              </div>
              <span className="price-sm">{money(item.lineTotal, item.currency)}</span>
            </li>
          ))}
        </ul>

        <div className="totals">
          <div className="totals-row">
            <span>Subtotal</span>
            <strong>{money(order.subtotal, order.currency)}</strong>
          </div>
          <div className="totals-row">
            <span>Shipping</span>
            <strong>{order.shipping ? money(order.shipping, order.currency) : 'Free'}</strong>
          </div>
          <div className="totals-row">
            <span>Tax</span>
            <strong>{money(order.tax, order.currency)}</strong>
          </div>
          <div className="totals-row totals-total">
            <strong>Total</strong>
            <span className="price">{money(order.total, order.currency)}</span>
          </div>
        </div>

        {address && (
          <div className="stack-sm">
            <p className="eyebrow">Shipping to</p>
            <p className="muted">
              {address.recipientName}, {address.line1}
              {address.line2 ? `, ${address.line2}` : ''}, {address.city}
              {address.stateOrProvince ? `, ${address.stateOrProvince}` : ''} {address.postalCode}, {address.country}
            </p>
          </div>
        )}

        {order.fulfillment === 'demo' && (
          <div className="notice notice-warning">
            <span aria-hidden>⚠</span>
            <span>Demo fulfilment: this order is recorded only. No payment was taken and nothing will ship.</span>
          </div>
        )}

        <ActionFeedback error={actions.error} success={actions.success} />

        <div className="actions">
          <ActionButton
            actionKey="history"
            actions={actions}
            label="Order history"
            onClick={() => actions.run('history', 'order_history', { limit: 10 })}
          />
          <ActionButton
            actionKey="detail"
            actions={actions}
            label="Order details"
            onClick={() => actions.run('detail', 'get_order', { order_id: order.orderId })}
          />
          {order.status === 'placed' && (
            <ConfirmButton
              actionKey="cancel"
              actions={actions}
              label="Cancel order"
              confirmLabel="Yes, cancel"
              question="Cancel this order?"
              variant="danger"
              onConfirm={() =>
                actions.run('cancel', 'cancel_order', { order_id: order.orderId }, {
                  successMessage: 'Order cancelled.',
                })
              }
            />
          )}
        </div>

        <p className="faint truncate">Order {order.orderId}</p>
      </div>
    </Card>
  );
}
