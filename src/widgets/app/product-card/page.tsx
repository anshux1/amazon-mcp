'use client';

import { useState } from 'react';
import { useWidgetSDK, useWidgetState } from '@nitrostack/widgets';
import {
  ActionButton,
  ActionFeedback,
  AvailabilityBadge,
  Card,
  ConfirmButton,
  Failure,
  Empty,
  Loading,
  Stepper,
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
  additionalImageUrls?: string[];
  itemWebUrl?: string;
  condition?: string;
  categoryId?: string;
  availableQuantity?: number | null;
  seller?: { username?: string; feedbackPercentage?: number };
  description?: string;
  shipping?: { value: number; currency: string };
  location?: string;
}

export default function ProductCard() {
  const { getToolOutput, isReady, openExternal } = useWidgetSDK();
  const output = getToolOutput<Product | ToolEnvelope<Product>>();
  const product = unwrap(output);
  const failure = errorOf(output);
  const actions = useToolActions();

  // Quantity survives a host re-render and is echoed back into widget state,
  // so the shopper does not lose their selection mid-conversation.
  const [widgetState, setWidgetState] = useWidgetState<{ quantity: number }>(() => ({ quantity: 1 }));
  const [gallery, setGallery] = useState(0);

  if (!isReady) return <Loading label="Loading product…" />;
  if (failure) return <Failure error={failure} />;
  if (!product) return <Empty mark="🔍" title="No product data" hint="Ask the assistant to search for an item." />;

  const quantity = Math.min(Math.max(widgetState?.quantity ?? 1, 1), 99);
  const setQuantity = (next: number) => setWidgetState({ quantity: next });

  const images = [product.imageUrl, ...(product.additionalImageUrls ?? [])].filter(
    (url): url is string => typeof url === 'string' && url.length > 0,
  );
  const outOfStock = product.availableQuantity !== null && product.availableQuantity !== undefined
    ? product.availableQuantity <= 0
    : false;
  const maxQuantity = Math.min(99, product.availableQuantity ?? 99);
  const lineTotal = product.price * quantity;
  const shipping = product.shipping?.value ?? 0;

  return (
    <Card>
      <div className="stack">
        <div className="header">
          <div className="grow">
            <p className="eyebrow">eBay product</p>
            <h2 className="title-lg clamp-2">{product.title}</h2>
          </div>
          <AvailabilityBadge quantity={product.availableQuantity} />
        </div>

        {images.length > 0 && (
          <div className="stack-sm">
            <img
              className="hero"
              src={images[Math.min(gallery, images.length - 1)]}
              alt={product.title}
              loading="lazy"
            />
            {images.length > 1 && (
              <div className="row row-wrap" style={{ gap: 6 }}>
                {images.slice(0, 6).map((url, index) => (
                  <button
                    key={url}
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: 2, border: index === gallery ? '2px solid var(--accent)' : '2px solid transparent' }}
                    onClick={() => setGallery(index)}
                    aria-label={`Image ${index + 1}`}
                  >
                    <Thumb src={url} alt="" size={42} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="row-between row-wrap">
          <div>
            <div className="price">{money(product.price, product.currency)}</div>
            <p className="muted">
              {shipping > 0 ? `+ ${money(shipping, product.shipping?.currency ?? product.currency)} shipping` : 'Free shipping'}
              {product.condition ? ` · ${product.condition}` : ''}
            </p>
          </div>
          <Stepper value={quantity} max={maxQuantity} disabled={outOfStock} onChange={setQuantity} />
        </div>

        {product.description && <p className="muted clamp-2">{product.description}</p>}

        <div className="row row-wrap" style={{ gap: 6 }}>
          {product.seller?.username && (
            <span className="badge">
              {product.seller.username}
              {product.seller.feedbackPercentage !== undefined ? ` · ${product.seller.feedbackPercentage}%` : ''}
            </span>
          )}
          {product.location && <span className="badge">{product.location}</span>}
          {product.categoryId && <span className="badge">Category {product.categoryId}</span>}
        </div>

        <ActionFeedback error={actions.error} success={actions.success} />

        <div className="actions">
          <ConfirmButton
            actionKey="add"
            actions={actions}
            label={`Add ${quantity} to cart`}
            confirmLabel="Add to cart"
            question={`Add ${quantity} × ${product.title.slice(0, 40)} for ${money(lineTotal, product.currency)}?`}
            disabled={outOfStock}
            onConfirm={() =>
              actions.run('add', 'add_to_cart', { item_id: product.itemId, quantity }, {
                successMessage: `Added ${quantity} to your cart.`,
                followUp: 'Show me my cart.',
              })
            }
          />
          <ConfirmButton
            actionKey="buy"
            actions={actions}
            label="Buy now"
            confirmLabel="Start checkout"
            question="Add this to the cart and start checkout?"
            variant="secondary"
            disabled={outOfStock}
            onConfirm={() =>
              actions.run('buy', 'add_to_cart', { item_id: product.itemId, quantity }, {
                successMessage: 'Added. Preparing your checkout quote…',
                followUp: 'Check out my cart and show me the total before I confirm.',
              })
            }
          />
          <ActionButton
            actionKey="cart"
            actions={actions}
            label="View cart"
            onClick={() => actions.run('cart', 'view_cart', {})}
          />
          {product.itemWebUrl && (
            <button type="button" className="btn btn-ghost" onClick={() => openExternal(product.itemWebUrl!)}>
              View on eBay ↗
            </button>
          )}
        </div>

        <div className="row-between">
          <span className="faint truncate">Item {product.itemId}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => actions.say(`Find me alternatives to "${product.title}" under ${money(product.price, product.currency)}.`)}
          >
            Find alternatives
          </button>
        </div>
      </div>
    </Card>
  );
}
