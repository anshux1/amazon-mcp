'use client';

import { useTheme, useWidgetSDK } from '@nitrostack/widgets';
import { errorMessage, money, unwrap, type ToolEnvelope } from '../../lib/widget-data';

interface Order {
  orderId: string;
  status: string;
  total: number;
  currency: string;
  createdAt?: string;
}

interface OrderData { orderId?: string; status?: string; total?: number; currency?: string; orders?: Order[] }

export default function OrderSummary() {
  const theme = useTheme();
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<OrderData | ToolEnvelope<OrderData>>();
  const data = unwrap(output);
  const error = errorMessage(output);
  const dark = theme === 'dark';

  if (!isReady) return <div className={`card ${dark ? 'dark' : ''}`}>Loading orders…</div>;
  if (error) return <div className={`card ${dark ? 'dark' : ''}`}><p className="error">{error}</p></div>;
  if (!data) return <div className={`card ${dark ? 'dark' : ''}`}><p className="muted">No order data received.</p></div>;

  const orders = data.orders ?? (data.orderId ? [data as Order] : []);
  return (
    <section className={`card ${dark ? 'dark' : ''}`}>
      <p className="eyebrow">Order history</p>
      <h2>{orders.length} order{orders.length === 1 ? '' : 's'}</h2>
      <ul className="list">
        {orders.map((order) => (
          <li className="list-item row" key={order.orderId}>
            <div><strong>{order.orderId}</strong><div className="muted">{order.status}{order.createdAt ? ` · ${order.createdAt}` : ''}</div></div>
            <span>{money(order.total, order.currency)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
