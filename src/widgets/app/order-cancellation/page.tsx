'use client';

import { useTheme, useWidgetSDK } from '@nitrostack/widgets';
import { errorMessage, unwrap, type ToolEnvelope } from '../../lib/widget-data';

interface Cancellation { orderId: string; status: string; cancelledAt?: string; message?: string }

export default function OrderCancellation() {
  const theme = useTheme();
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<Cancellation | ToolEnvelope<Cancellation>>();
  const data = unwrap(output);
  const error = errorMessage(output);
  const dark = theme === 'dark';

  if (!isReady) return <div className={`card ${dark ? 'dark' : ''}`}>Cancelling order…</div>;
  if (error) return <div className={`card ${dark ? 'dark' : ''}`}><p className="error">{error}</p></div>;
  if (!data) return <div className={`card ${dark ? 'dark' : ''}`}><p className="muted">No cancellation result received.</p></div>;

  return (
    <section className={`card ${dark ? 'dark' : ''}`}>
      <p className="eyebrow">Order update</p>
      <h2>Order cancelled</h2>
      <p><strong>{data.orderId}</strong> · {data.status}</p>
      {data.cancelledAt && <p className="muted">Cancelled {data.cancelledAt}</p>}
      {data.message && <p>{data.message}</p>}
    </section>
  );
}
