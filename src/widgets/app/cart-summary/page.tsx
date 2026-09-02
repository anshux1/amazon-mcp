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
  Stepper,
  Thumb,
  errorOf,
  expiresIn,
  money,
  unwrap,
  useToolActions,
  type ToolEnvelope,
} from '../../lib/ui';

interface LineItem {
  itemId: string;
  title: string;
  quantity: number;
  unitPrice: number | null;
  currency: string;
  imageUrl?: string;
  condition?: string;
}

/**
 * Rendered by add_to_cart, view_cart, update_cart_item (a cart) and by
 * checkout (a quote). The presence of `checkoutId` is what distinguishes them.
 */
interface CartOrQuote {
  itemCount: number;
  subtotal: number;
  currency: string;
  items: LineItem[];
  revision?: string;
  updatedAt?: string;
  checkoutId?: string;
  cartRevision?: string;
  shipping?: number;
  tax?: number;
  total?: number;
  expiresAt?: string;
}

export default function CartSummary() {
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<CartOrQuote | ToolEnvelope<CartOrQuote>>();
  const data = unwrap(output);
  const failure = errorOf(output);
  const actions = useToolActions();
  const [view, setView] = useWidgetState<{ expanded: boolean }>(() => ({ expanded: true }));

  if (!isReady) return <Loading label="Loading cart…" />;
  if (failure) return <Failure error={failure} />;
  if (!data) return <Empty mark="🛒" title="No cart data" hint="Ask the assistant to show your cart." />;

  const isQuote = Boolean(data.checkoutId);
  const expanded = view?.expanded ?? true;

  if (data.items.length === 0) {
    return (
      <Card>
        <div className="stack">
          <div className="empty">
            <div className="empty-mark" aria-hidden>🛒</div>
            <p className="title">Your cart is empty</p>
            <p className="muted">Search the catalog and add something to get started.</p>
          </div>
          <ActionButton
            actionKey="browse"
            actions={actions}
            label="Browse popular items"
            variant="primary"
            block
            onClick={() => actions.say('Show me some popular products.')}
          />
        </div>
      </Card>
    );
  }

  const total = data.total ?? data.subtotal;
  const remaining = expiresIn(data.expiresAt);
  const expired = remaining === 'expired';

  return (
    <Card>
      <div className="stack">
        <div className="header">
          <div className="grow">
            <p className="eyebrow">{isQuote ? 'Checkout quote' : 'Shopping cart'}</p>
            <h2 className="title-lg">
              {data.itemCount} item{data.itemCount === 1 ? '' : 's'}
            </h2>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setView({ expanded: !expanded })}>
            {expanded ? 'Hide items' : 'Show items'}
          </button>
        </div>

        {isQuote && (
          <div className={`notice ${expired ? 'notice-error' : 'notice-info'}`}>
            <span aria-hidden>{expired ? '⏱' : 'ℹ'}</span>
            <span>
              {expired
                ? 'This quote has expired. Run checkout again to get current prices.'
                : `Prices are locked for this quote${remaining ? ` · ${remaining}` : ''}. Placing the order re-checks price and stock.`}
            </span>
          </div>
        )}

        {expanded && (
          <ul className="list">
            {data.items.map((item) => (
              <li className="item" key={item.itemId}>
                <Thumb src={item.imageUrl} alt={item.title} />
                <div className="grow">
                  <p className="clamp-2" style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</p>
                  <p className="faint">
                    {item.unitPrice === null ? 'Price at checkout' : money(item.unitPrice, item.currency)} each
                    {item.condition ? ` · ${item.condition}` : ''}
                  </p>
                  {!isQuote && (
                    <div className="row" style={{ marginTop: 6, gap: 8 }}>
                      <Stepper
                        value={item.quantity}
                        min={1}
                        disabled={actions.pending !== null}
                        onChange={(next) =>
                          actions.run(`qty-${item.itemId}`, 'update_cart_item', {
                            item_id: item.itemId,
                            quantity: next,
                          })
                        }
                      />
                      <ConfirmButton
                        actionKey={`remove-${item.itemId}`}
                        actions={actions}
                        label="Remove"
                        confirmLabel="Remove"
                        question="Remove this item?"
                        variant="danger"
                        small
                        onConfirm={() =>
                          actions.run(`remove-${item.itemId}`, 'update_cart_item', {
                            item_id: item.itemId,
                            quantity: 0,
                          }, { successMessage: 'Item removed.' })
                        }
                      />
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="price-sm">
                    {item.unitPrice === null ? '—' : money(item.unitPrice * item.quantity, item.currency)}
                  </div>
                  {isQuote && <div className="faint">× {item.quantity}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="totals">
          <div className="totals-row">
            <span>Subtotal</span>
            <strong>{money(data.subtotal, data.currency)}</strong>
          </div>
          {isQuote && (
            <>
              <div className="totals-row">
                <span>Shipping</span>
                <strong>{data.shipping ? money(data.shipping, data.currency) : 'Free'}</strong>
              </div>
              <div className="totals-row">
                <span>Tax</span>
                <strong>{money(data.tax ?? 0, data.currency)}</strong>
              </div>
            </>
          )}
          <div className="totals-row totals-total">
            <strong>{isQuote ? 'Total' : 'Estimated total'}</strong>
            <span className="price">{money(total, data.currency)}</span>
          </div>
        </div>

        <ActionFeedback error={actions.error} success={actions.success} />

        <div className="actions">
          {isQuote ? (
            <ConfirmButton
              actionKey="place"
              actions={actions}
              label={`Place order · ${money(total, data.currency)}`}
              confirmLabel="Yes, place order"
              question={`Place this order for ${money(total, data.currency)}?`}
              block
              disabled={expired}
              onConfirm={() =>
                actions.run('place', 'place_order', { checkout_id: data.checkoutId }, {
                  successMessage: 'Order placed.',
                  followUp: 'Show me my order confirmation.',
                })
              }
            />
          ) : (
            <ActionButton
              actionKey="checkout"
              actions={actions}
              label="Checkout"
              variant="primary"
              onClick={() =>
                actions.run('checkout', 'checkout', {}, { successMessage: 'Quote ready — review the total below.' })
              }
            />
          )}
          <ActionButton
            actionKey="refresh"
            actions={actions}
            label="Refresh cart"
            onClick={() => actions.run('refresh', 'view_cart', {})}
          />
          {isQuote && expired && (
            <ActionButton
              actionKey="requote"
              actions={actions}
              label="New quote"
              variant="primary"
              onClick={() => actions.run('requote', 'checkout', {})}
            />
          )}
        </div>

        {isQuote && data.checkoutId && (
          <p className="faint truncate">Quote {data.checkoutId}</p>
        )}
      </div>
    </Card>
  );
}
