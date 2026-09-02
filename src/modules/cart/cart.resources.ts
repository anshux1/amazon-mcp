import { ResourceDecorator as Resource, type ExecutionContext } from '@nitrostack/core';

export class CartResources {
  @Resource({
    uri: 'shopping://cart-guide',
    name: 'Cart Guide',
    description: 'Instructions for adding, viewing, and updating cart items.',
    mimeType: 'text/markdown',
    metadata: { cacheable: true, cacheMaxAge: 3600000 },
    examples: {
      response: '# Cart Guide\n\nUse add_to_cart, view_cart, and update_cart_item.',
    },
  })
  async getCartGuide(_uri: string, _ctx: ExecutionContext): Promise<string> {
    return `# Cart Guide

- \`add_to_cart\` takes only \`item_id\` and \`quantity\`. The title, price, currency, URL,
  and availability are fetched from eBay by the server, so a caller cannot put a forged
  price into a cart and an item that does not exist is rejected.
- \`view_cart\` returns the current cart, its displayed subtotal, and a \`revision\`
  fingerprint. A checkout quote is bound to that revision.
- \`update_cart_item\` sets a quantity; use 0 to remove an item.
- The \`userId\` is always taken from the verified JWT subject and is never accepted as input.
- Checkout re-fetches every item, so the displayed price is never treated as final.
`;
  }
}
