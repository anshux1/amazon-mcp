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

Checkout quotes expire after ten minutes. Every order and history query is scoped to the
verified JWT subject.
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
    };
  }
}
