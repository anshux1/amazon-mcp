import { PromptDecorator as Prompt, type ExecutionContext } from '@nitrostack/core';

export class ProductsPrompts {
  @Prompt({
    name: 'shopping_assistant',
    description: 'A reusable prompt for researching products and preparing a safe cart workflow.',
    arguments: [
      {
        name: 'request',
        description: 'What the shopper wants to find',
        required: true,
      },
      {
        name: 'budget',
        description: 'Optional maximum budget in USD',
        required: false,
      },
    ],
  })
  async shoppingAssistant(
    args: { request?: string; budget?: string },
    _ctx: ExecutionContext,
  ) {
    const request = args.request?.trim() || 'the requested product';
    const budget = args.budget ? ` Keep the total item price under $${args.budget}.` : '';
    return [
      {
        role: 'user' as const,
        content: `Help me shop for ${request}.${budget}`,
      },
      {
        role: 'assistant' as const,
        content:
          'First search_products, compare the returned products, inspect the selected item with get_product, then ask for confirmation before changing the cart.',
      },
    ];
  }
}
