'use client';

import { useWidgetSDK, useWidgetState } from '@nitrostack/widgets';
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
  timeAgo,
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
  items?: OrderItem[];
  subtotal?: number;
  shipping?: number;
  tax?: number;
  total: number;
  currency: string;
  fulfillment?: string;
  createdAt?: string;
  cancelledAt?: string;
}

/** get_order returns one order; order_history returns { count, orders }. */
interface OrderOutput extends Partial<Order> {
  count?: number;
  orders?: Order[];
}

type Filter = 'all' | 'placed' | 'cancelled';

export default function OrderSummary() {
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<OrderOutput | ToolEnvelope<OrderOutput>>();
  const data = unwrap(output);
  const failure = errorOf(output);
  const actions = useToolActions();
  const [view, setView] = useWidgetState<{ filter: Filter }>(() => ({ filter: 'all' }));

  if (!isReady) return <Loading label="Loading orders…" />;
  if (failure) return <Failure error={failure} />;
  if (!data) return <Empty mark="🧾" title="No order data" hint="Ask the assistant for your order history." />;

  const single = data.orders === undefined && data.orderId !== undefined;
  const orders: Order[] = data.orders ?? (data.orderId ? [data as Order] : []);

  if (orders.length === 0) {
    return (
      <Card>
        <div className="stack">
          <div className="empty">
            <div className="empty-mark" aria-hidden>🧾</div>
            <p className="title">No orders yet</p>
            <p className="muted">Orders you place will show up here.</p>
          </div>
          <ActionButton
            actionKey="browse"
            actions={actions}
            label="Start shopping"
            variant="primary"
            block
            onClick={() => actions.say('Show me some popular products.')}
          />
        </div>
      </Card>
    );
  }

  // A single order arrives with its line items; a history page is a summary,
  // so it renders as a compact list with a drill-in action instead.
  if (single) {
    const order = orders[0];
    return (
      <Card>
        <div className="stack">
          <div className="header">
            <div className="grow">
              <p className="eyebrow">Order</p>
              <h2 className="title-lg truncate">{order.orderId}</h2>
              <p className="muted">{order.createdAt ? `Placed ${timeAgo(order.createdAt)}` : ''}</p>
            </div>
            <StatusBadge status={order.status} />
          </div>

          {order.items && order.items.length > 0 && (
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
          )}

          <div className="totals">
            {order.subtotal !== undefined && (
              <div className="totals-row">
                <span>Subtotal</span>
                <strong>{money(order.subtotal, order.currency)}</strong>
              </div>
            )}
            {order.shipping !== undefined && (
              <div className="totals-row">
                <span>Shipping</span>
                <strong>{order.shipping ? money(order.shipping, order.currency) : 'Free'}</strong>
              </div>
            )}
            {order.tax !== undefined && (
              <div className="totals-row">
                <span>Tax</span>
                <strong>{money(order.tax, order.currency)}</strong>
              </div>
            )}
            <div className="totals-row totals-total">
              <strong>Total</strong>
              <span className="price">{money(order.total, order.currency)}</span>
            </div>
          </div>

          {order.cancelledAt && (
            <div className="notice notice-error">
              <span aria-hidden>✕</span>
              <span>Cancelled {timeAgo(order.cancelledAt)}.</span>
            </div>
          )}

          <ActionFeedback error={actions.error} success={actions.success} />

          <div className="actions">
            <ActionButton
              actionKey="history"
              actions={actions}
              label="All orders"
              onClick={() => actions.run('history', 'order_history', { limit: 20 })}
            />
            {order.status === 'placed' && (
              <ConfirmButton
                actionKey="cancel"
                actions={actions}
                label="Cancel order"
                confirmLabel="Yes, cancel"
                question={`Cancel order for ${money(order.total, order.currency)}?`}
                variant="danger"
                onConfirm={() =>
                  actions.run('cancel', 'cancel_order', { order_id: order.orderId }, {
                    successMessage: 'Order cancelled.',
                  })
                }
              />
            )}
          </div>
        </div>
      </Card>
    );
  }

  const filter = view?.filter ?? 'all';
  const visible = orders.filter((order) => filter === 'all' || order.status === filter);
  const currency = orders[0].currency;
  const spend = orders
    .filter((order) => order.status === 'placed')
    .reduce((total, order) => total + order.total, 0);

  return (
    <Card>
      <div className="stack">
        <div className="header">
          <div className="grow">
            <p className="eyebrow">Order history</p>
            <h2 className="title-lg">
              {orders.length} order{orders.length === 1 ? '' : 's'}
            </h2>
            <p className="muted">{money(spend, currency)} across active orders</p>
          </div>
          <div className="row" style={{ gap: 4 }}>
            {(['all', 'placed', 'cancelled'] as Filter[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`btn btn-sm ${filter === key ? '' : 'btn-secondary'}`}
                onClick={() => setView({ filter: key })}
              >
                {key === 'all' ? 'All' : key === 'placed' ? 'Active' : 'Cancelled'}
              </button>
            ))}
          </div>
        </div>

        <ActionFeedback error={actions.error} success={actions.success} />

        {visible.length === 0 ? (
          <div className="notice notice-info">
            <span aria-hidden>ℹ</span>
            <span>No {filter} orders.</span>
          </div>
        ) : (
          <ul className="list">
            {visible.map((order) => (
              <li className="item" key={order.orderId}>
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="truncate" style={{ fontWeight: 600, fontSize: 13 }}>{order.orderId}</span>
                    <StatusBadge status={order.status} />
                  </div>
                  <p className="faint">
                    {order.createdAt ? timeAgo(order.createdAt) : ''}
                    {order.items ? ` · ${order.items.length} item${order.items.length === 1 ? '' : 's'}` : ''}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="price-sm">{money(order.total, order.currency)}</div>
                  <ActionButton
                    actionKey={`open-${order.orderId}`}
                    actions={actions}
                    label="Details"
                    variant="ghost"
                    small
                    onClick={() => actions.run(`open-${order.orderId}`, 'get_order', { order_id: order.orderId })}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
