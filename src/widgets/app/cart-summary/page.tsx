'use client';

import { useWidgetState, useTheme, useWidgetSDK } from '@nitrostack/widgets';
import { errorMessage, money, unwrap, type ToolEnvelope } from '../../lib/widget-data';

interface CartItem {
  itemId: string;
  title: string;
  quantity: number;
  unitPrice: number | null;
  currency: string;
  imageUrl?: string;
}

interface CartData {
  itemCount: number;
  subtotal: number;
  currency: string;
  items: CartItem[];
  updatedAt?: string;
  checkoutId?: string;
  shipping?: number;
  tax?: number;
  total?: number;
  expiresAt?: string;
}

export default function CartSummary() {
  const theme = useTheme();
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<CartData | ToolEnvelope<CartData>>();
  const data = unwrap(output);
  const error = errorMessage(output);
  const [state, setState] = useWidgetState<{ showDetails: boolean }>(() => ({ showDetails: true }));
  const dark = theme === 'dark';

  if (!isReady) return <div className={`card ${dark ? 'dark' : ''}`}>Loading cart…</div>;
  if (error) return <div className={`card ${dark ? 'dark' : ''}`}><p className="error">{error}</p></div>;
  if (!data) return <div className={`card ${dark ? 'dark' : ''}`}><p className="muted">Your cart is empty.</p></div>;

  const total = data.total ?? data.subtotal;
  return (
    <section className={`card ${dark ? 'dark' : ''}`}>
      <div className="row">
        <div><p className="eyebrow">{data.checkoutId ? 'Checkout quote' : 'Shopping cart'}</p><h2>{data.itemCount} item{data.itemCount === 1 ? '' : 's'}</h2></div>
        <button onClick={() => setState({ showDetails: !state?.showDetails })}>
          {state?.showDetails ? 'Hide details' : 'Show details'}
        </button>
      </div>
      {data.checkoutId && <p className="muted">Quote {data.checkoutId} · expires {data.expiresAt}</p>}
      {state?.showDetails && (
        <ul className="list">
          {data.items.map((item) => (
            <li className="list-item row" key={item.itemId}>
              <div><strong>{item.title}</strong><div className="muted">Qty {item.quantity}</div></div>
              <span>{item.unitPrice == null ? 'Price at checkout' : money(item.unitPrice * item.quantity, item.currency)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ borderTop: '1px solid currentColor', paddingTop: 14 }}>
        <strong>{data.checkoutId ? 'Total' : 'Subtotal'}</strong>
        <span className="price" style={{ fontSize: 20 }}>{money(total, data.currency)}</span>
      </div>
      {data.checkoutId && <p className="muted">Shipping {money(data.shipping ?? 0, data.currency)} · Tax {money(data.tax ?? 0, data.currency)}</p>}
    </section>
  );
}
