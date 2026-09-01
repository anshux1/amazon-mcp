'use client';

import { useTheme, useWidgetSDK } from '@nitrostack/widgets';
import { errorMessage, money, unwrap, type ToolEnvelope } from '../../lib/widget-data';

interface Order {
  orderId: string;
  status: string;
  total: number;
  currency: string;
  items: Array<{ itemId: string; title: string; quantity: number }>;
}

interface Confirmation { order: Order; message?: string }

export default function OrderConfirmation() {
  const theme = useTheme();
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<Confirmation | ToolEnvelope<Confirmation>>();
  const data = unwrap(output);
  const error = errorMessage(output);
  const dark = theme === 'dark';

  if (!isReady) return <div className={`card ${dark ? 'dark' : ''}`}>Placing order…</div>;
  if (error) return <div className={`card ${dark ? 'dark' : ''}`}><p className="error">{error}</p></div>;
  if (!data) return <div className={`card ${dark ? 'dark' : ''}`}><p className="muted">No order confirmation received.</p></div>;

  return (
    <section className={`card ${dark ? 'dark' : ''}`}>
      <p className="eyebrow">Order confirmed</p>
      <h2>Thanks for your order</h2>
      <p className="muted">{data.order.orderId} · {data.order.status}</p>
      <p className="price">{money(data.order.total, data.order.currency)}</p>
      <ul className="list">
        {data.order.items.map((item) => <li className="list-item row" key={item.itemId}><span>{item.title}</span><strong>×{item.quantity}</strong></li>)}
      </ul>
      {data.message && <p>{data.message}</p>}
    </section>
  );
}
