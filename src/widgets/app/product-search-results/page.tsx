'use client';

import { useTheme, useWidgetSDK } from '@nitrostack/widgets';
import { errorMessage, money, unwrap, type ToolEnvelope } from '../../lib/widget-data';

interface Product {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  imageUrl?: string;
  condition?: string;
}

interface SearchResult {
  total: number;
  offset: number;
  limit: number;
  source: string;
  items: Product[];
}

export default function ProductSearchResults() {
  const theme = useTheme();
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<SearchResult | ToolEnvelope<SearchResult>>();
  const result = unwrap(output);
  const error = errorMessage(output);
  const dark = theme === 'dark';

  if (!isReady) return <div className={`card ${dark ? 'dark' : ''}`}>Searching the catalog…</div>;
  if (error) return <div className={`card ${dark ? 'dark' : ''}`}><p className="error">{error}</p></div>;
  if (!result) return <div className={`card ${dark ? 'dark' : ''}`}><p className="muted">No products found.</p></div>;

  return (
    <section className={`card ${dark ? 'dark' : ''}`}>
      <div className="row">
        <div><p className="eyebrow">Catalog search</p><h2>{result.total} result{result.total === 1 ? '' : 's'}</h2></div>
        <span className="muted">{result.source}</span>
      </div>
      <ul className="list">
        {result.items.map((product) => (
          <li className="list-item row" key={product.itemId}>
            <div>
              <strong>{product.title}</strong>
              <div className="muted">{product.condition ?? 'Condition unavailable'} · {product.itemId}</div>
            </div>
            <span className="price" style={{ fontSize: 17 }}>{money(product.price, product.currency)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
