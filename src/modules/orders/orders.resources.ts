import { ResourceDecorator as Resource, type ExecutionContext } from '@nitrostack/core';

export class OrdersResources {
  @Resource({
    uri: 'shopping://order-guide',
    name: 'Order Guide',
    description: 'The safe checkout and order-management sequence for the shopping MCP server.',
    mimeType: 'text/markdown',
    metadata: { cacheable: true, cacheMaxAge: 3600000 },
    examples: {
      response: '# Order Guide\n\nRun checkout, confirm the quote, then place_order.',
    },
  })
  async getOrderGuide(_uri: string, _ctx: ExecutionContext): Promise<string> {
    return `# Order Guide

1. Add products and review them with \`view_cart\`.
2. Run \`checkout\` to fetch live eBay prices and availability.
3. Show the quote and ask the shopper to confirm it.
4. Run \`place_order\` with the returned \`checkout_id\`.
5. Use \`get_order\`, \`order_history\`, or \`cancel_order\` for later management.

Checkout quotes expire after ten minutes by default and are bound to the cart they were
priced from. If the cart changes afterwards, \`place_order\` returns a conflict and leaves
the newer cart untouched: run \`checkout\` again. Prices and availability are re-read
immediately before placement, so a change since the quote is also a conflict.

\`place_order\` is safe to retry: the \`checkout_id\` is its idempotency key, so a retry
after a timeout returns the order the first attempt created (\`alreadyPlaced: true\`)
rather than placing a second one.

Every order and history query is scoped to the verified JWT subject.

This server records orders in its own database only. There is no payment, no inventory
reservation, and no eBay fulfilment: an order reports \`fulfillment: "demo"\`, and any
order that is not already cancelled can be cancelled.
`;
  }

  @Resource({
    uri: 'shopping://order-statuses',
    name: 'Order Statuses',
    description: 'Supported order lifecycle states.',
    mimeType: 'application/json',
    metadata: { cacheable: true, cacheMaxAge: 3600000 },
    examples: {
      response: { statuses: ['placed', 'cancelled'] },
    },
  })
  async getOrderStatuses(_uri: string, _ctx: ExecutionContext) {
    return {
      statuses: [
        { name: 'placed', description: 'The order was created from a confirmed checkout quote.' },
        { name: 'cancelled', description: 'The order was cancelled by the authenticated shopper.' },
      ],
      fulfillment: {
        mode: 'demo',
        description:
          'Orders are recorded in this server only. No payment is authorized, no inventory is reserved, and nothing is shipped, so there are no states beyond placed and cancelled.',
      },
    };
  }
}
