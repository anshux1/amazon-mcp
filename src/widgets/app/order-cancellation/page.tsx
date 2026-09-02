'use client';

import { useWidgetSDK } from '@nitrostack/widgets';
import {
  ActionButton,
  ActionFeedback,
  Card,
  Empty,
  Failure,
  Loading,
  StatusBadge,
  errorOf,
  timeAgo,
  unwrap,
  useToolActions,
  type ToolEnvelope,
} from '../../lib/ui';

interface Cancellation {
  orderId: string;
  status: string;
  cancelledAt?: string;
  message?: string;
}

export default function OrderCancellation() {
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<Cancellation | ToolEnvelope<Cancellation>>();
  const data = unwrap(output);
  const failure = errorOf(output);
  const actions = useToolActions();

  if (!isReady) return <Loading label="Cancelling order…" />;
  if (failure) return <Failure error={failure} />;
  if (!data) return <Empty mark="🧾" title="No cancellation result" hint="Ask the assistant to cancel an order." />;

  return (
    <Card>
      <div className="stack">
        <div className="header">
          <div className="grow">
            <p className="eyebrow">Order update</p>
            <h2 className="title-lg">Order cancelled</h2>
            <p className="muted truncate">{data.orderId}</p>
          </div>
          <StatusBadge status={data.status} />
        </div>

        <div className="notice notice-success">
          <span aria-hidden>✓</span>
          <span>{data.message ?? 'This order has been cancelled.'}</span>
        </div>

        {data.cancelledAt && <p className="faint">Cancelled {timeAgo(data.cancelledAt)}</p>}

        <ActionFeedback error={actions.error} success={actions.success} />

        <div className="actions">
          <ActionButton
            actionKey="history"
            actions={actions}
            label="Order history"
            variant="primary"
            onClick={() => actions.run('history', 'order_history', { limit: 20 })}
          />
          <ActionButton
            actionKey="cart"
            actions={actions}
            label="View cart"
            onClick={() => actions.run('cart', 'view_cart', {})}
          />
          <ActionButton
            actionKey="shop"
            actions={actions}
            label="Keep shopping"
            variant="ghost"
            onClick={() => actions.say('Show me something similar to what I just cancelled.')}
          />
        </div>
      </div>
    </Card>
  );
}
