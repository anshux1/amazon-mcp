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
  Thumb,
  errorOf,
  money,
  unwrap,
  useToolActions,
  type ToolEnvelope,
} from '../../lib/ui';

interface Product {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  imageUrl?: string;
  condition?: string;
  availableQuantity?: number | null;
  seller?: { username?: string; feedbackPercentage?: number };
}

interface SearchResult {
  total: number;
  offset: number;
  limit: number;
  source: string;
  items: Product[];
}

type SortKey = 'relevance' | 'price-asc' | 'price-desc';

export default function ProductSearchResults() {
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<SearchResult | ToolEnvelope<SearchResult>>();
  const result = unwrap(output);
  const failure = errorOf(output);
  const actions = useToolActions();
  const [view, setView] = useWidgetState<{ sort: SortKey }>(() => ({ sort: 'relevance' }));

  if (!isReady) return <Loading label="Searching the catalog…" />;
  if (failure) return <Failure error={failure} />;
  if (!result || result.items.length === 0) {
    return <Empty mark="🔎" title="No matching products" hint="Try a broader search, or a different category." />;
  }

  const sort = view?.sort ?? 'relevance';
  // Sorting here is presentational only: it reorders the page the server
  // returned and never refetches, so it cannot spend eBay budget.
  const items = [...result.items].sort((left, right) =>
    sort === 'price-asc' ? left.price - right.price : sort === 'price-desc' ? right.price - left.price : 0,
  );
  const hasMore = result.total > result.offset + result.items.length;

  return (
    <Card>
      <div className="stack">
        <div className="header">
          <div className="grow">
            <p className="eyebrow">Catalog search</p>
            <h2 className="title-lg">
              {result.total.toLocaleString()} result{result.total === 1 ? '' : 's'}
            </h2>
            <p className="muted">
              Showing {result.offset + 1}–{result.offset + result.items.length}
              {result.source === 'demo' ? ' · demo catalog' : ''}
            </p>
          </div>
          <div className="row" style={{ gap: 4 }}>
            {(
              [
                ['relevance', 'Best'],
                ['price-asc', '$ ↑'],
                ['price-desc', '$ ↓'],
              ] as Array<[SortKey, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`btn btn-sm ${sort === key ? '' : 'btn-secondary'}`}
                onClick={() => setView({ sort: key })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <ActionFeedback error={actions.error} success={actions.success} />

        <div className="grid">
          {items.map((product) => (
            <article className="tile" key={product.itemId}>
              {product.imageUrl ? (
                <img className="tile-image" src={product.imageUrl} alt={product.title} loading="lazy" />
              ) : (
                <div className="tile-image" style={{ display: 'grid', placeItems: 'center', fontSize: 26 }} aria-hidden>
                  🛍
                </div>
              )}
              <div className="grow">
                <p className="clamp-2" style={{ fontWeight: 600, fontSize: 13 }}>{product.title}</p>
                <p className="faint truncate">{product.condition ?? 'Condition unavailable'}</p>
              </div>
              <div className="row-between">
                <span className="price-sm">{money(product.price, product.currency)}</span>
                {product.availableQuantity !== null && product.availableQuantity !== undefined && product.availableQuantity <= 5 && (
                  <span className="badge badge-warning">{product.availableQuantity} left</span>
                )}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <ActionButton
                  actionKey={`view-${product.itemId}`}
                  actions={actions}
                  label="Details"
                  small
                  onClick={() => actions.run(`view-${product.itemId}`, 'get_product', { item_id: product.itemId })}
                />
                <ConfirmButton
                  actionKey={`add-${product.itemId}`}
                  actions={actions}
                  label="Add"
                  confirmLabel="Add"
                  question={`Add for ${money(product.price, product.currency)}?`}
                  small
                  onConfirm={() =>
                    actions.run(`add-${product.itemId}`, 'add_to_cart', { item_id: product.itemId, quantity: 1 }, {
                      successMessage: `Added ${product.title.slice(0, 30)} to your cart.`,
                    })
                  }
                />
              </div>
            </article>
          ))}
        </div>

        <div className="row-between row-wrap">
          <ActionButton
            actionKey="cart"
            actions={actions}
            label="View cart"
            onClick={() => actions.run('cart', 'view_cart', {})}
          />
          {hasMore && (
            <ActionButton
              actionKey="more"
              actions={actions}
              label="Show more"
              variant="ghost"
              onClick={() => actions.say('Show me the next page of results.')}
            />
          )}
        </div>
      </div>
    </Card>
  );
}
