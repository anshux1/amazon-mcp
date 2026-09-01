'use client';

import { useTheme, useWidgetSDK } from '@nitrostack/widgets';
import { errorMessage, money, unwrap, type ToolEnvelope } from '../../lib/widget-data';

interface Product {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  imageUrl?: string;
  itemWebUrl?: string;
  condition?: string;
  availableQuantity?: number | null;
  seller?: { username?: string; feedbackPercentage?: number };
  description?: string;
}

export default function ProductCard() {
  const theme = useTheme();
  const { getToolOutput, isReady, openExternal } = useWidgetSDK();
  const output = getToolOutput<Product | ToolEnvelope<Product>>();
  const product = unwrap(output);
  const error = errorMessage(output);
  const dark = theme === 'dark';

  if (!isReady) return <div className={`card ${dark ? 'dark' : ''}`}>Connecting to shopping server…</div>;
  if (error) return <div className={`card ${dark ? 'dark' : ''}`}><p className="error">{error}</p></div>;
  if (!product) return <div className={`card ${dark ? 'dark' : ''}`}><p className="muted">No product data received.</p></div>;

  return (
    <article className={`card ${dark ? 'dark' : ''}`}>
      <p className="eyebrow">eBay product</p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2>{product.title}</h2>
          <p className="price">{money(product.price, product.currency)}</p>
        </div>
        {product.imageUrl && (
          <img src={product.imageUrl} alt="" width={92} height={92} style={{ borderRadius: 12, objectFit: 'cover' }} />
        )}
      </div>
      <p className="muted">{product.condition ?? 'Condition not supplied'} · {product.availableQuantity == null ? 'Availability at checkout' : `${product.availableQuantity} available`}</p>
      {product.description && <p>{product.description}</p>}
      <div className="row">
        <small className="muted">Item: {product.itemId}</small>
        {product.itemWebUrl && <button onClick={() => openExternal(product.itemWebUrl!)}>View on eBay</button>}
      </div>
    </article>
  );
}
