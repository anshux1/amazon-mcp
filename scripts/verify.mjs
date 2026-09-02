#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { generateJWT } from '@nitrostack/core';

const root = new URL('..', import.meta.url);
const projectRoot = fileURLToPath(root);
const serverPath = fileURLToPath(new URL('./dist/index.js', root));
const secret = 'verify-secret-with-enough-entropy';
const expectedTools = [
  'search_products',
  'get_product',
  'get_categories',
  'add_to_cart',
  'view_cart',
  'update_cart_item',
  'checkout',
  'place_order',
  'get_order',
  'order_history',
  'cancel_order',
];
const expectedResources = [
  'shopping://catalog-guide',
  'shopping://featured-products',
  'shopping://categories',
  'shopping://cart-guide',
  'shopping://order-guide',
  'shopping://order-statuses',
  'metrics://shopping',
  'health://checks',
  'widget://examples',
];
const widgetTools = {
  search_products: 'ui://widget/next-product-search-results.html',
  get_product: 'ui://widget/next-product-card.html',
  get_categories: 'ui://widget/next-category-tree.html',
  add_to_cart: 'ui://widget/next-cart-summary.html',
  view_cart: 'ui://widget/next-cart-summary.html',
  update_cart_item: 'ui://widget/next-cart-summary.html',
  checkout: 'ui://widget/next-cart-summary.html',
  place_order: 'ui://widget/next-order-confirmation.html',
  get_order: 'ui://widget/next-order-summary.html',
  order_history: 'ui://widget/next-order-summary.html',
  cancel_order: 'ui://widget/next-order-cancellation.html',
};
const ebayImageHosts = [
  'https://i.ebayimg.com',
  'https://*.ebayimg.com',
  'https://secureir.ebaystatic.com',
  'https://*.ebaystatic.com',
];
// Widgets that render catalog imagery must declare the eBay image hosts, or a
// strict client sandbox silently drops every product picture.
const cspTools = new Set([
  'search_products',
  'get_product',
  'add_to_cart',
  'view_cart',
  'update_cart_item',
  'checkout',
  'place_order',
  'get_order',
  'order_history',
]);

const previousSecret = 'verify-previous-secret-with-enough-entropy';
const serverEnv = {
  ...process.env,
  NODE_ENV: 'development',
  MCP_TRANSPORT_TYPE: 'stdio',
  NITROSTACK_APP_MODE: 'universal',
  DATABASE_FILE: ':memory:',
  EBAY_MOCK: 'true',
  JWT_SECRET: secret,
  JWT_SECRET_PREVIOUS: previousSecret,
  JWT_AUDIENCE: 'amazon-mcp',
  JWT_ISSUER: 'better-auth',
  PORT: '0',
};
delete serverEnv.DATABASE_URL;
delete serverEnv.DATABASE_SSL;

const child = spawn(process.execPath, [serverPath], {
  cwd: projectRoot,
  env: serverEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutBuffer = '';
let stderrBuffer = '';
let nextId = 1;
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      rejectAll(new Error(`Server emitted invalid JSON: ${line}`));
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
      else resolve(message.result);
    }
  }
});
child.stderr.on('data', (chunk) => { stderrBuffer += chunk; });
child.on('error', (error) => rejectAll(error));
child.on('exit', (code, signal) => {
  if (pending.size > 0) {
    rejectAll(new Error(`MCP server exited (${code ?? 'null'}/${signal ?? 'no signal'})\n${stderrBuffer}`));
  }
});

function rejectAll(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

async function withTimeout(promise, label, timeoutMs = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseToolResult(result, name) {
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) throw new Error(`${name} returned no text content`);
  const payload = JSON.parse(text);
  if (result.structuredContent && JSON.stringify(result.structuredContent) !== JSON.stringify(payload)) {
    throw new Error(`${name} structuredContent does not match text payload`);
  }
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const token = generateJWT({
  secret,
  payload: { sub: 'verify-user', scopes: ['shopping:read', 'shopping:write'] },
  audience: 'amazon-mcp',
  issuer: 'better-auth',
  expiresIn: '10m',
});
const otherToken = generateJWT({
  secret,
  payload: { sub: 'other-user', scopes: ['shopping:read', 'shopping:write'] },
  audience: 'amazon-mcp',
  issuer: 'better-auth',
  expiresIn: '10m',
});
const previousToken = generateJWT({
  secret: previousSecret,
  payload: { sub: 'rotated-user', scopes: ['shopping:read', 'shopping:write'] },
  audience: 'amazon-mcp',
  issuer: 'better-auth',
  expiresIn: '10m',
});
const readOnlyToken = generateJWT({
  secret,
  payload: { sub: 'read-only-user', scopes: ['shopping:read'] },
  audience: 'amazon-mcp',
  issuer: 'better-auth',
  expiresIn: '10m',
});
const writeOnlyToken = generateJWT({
  secret,
  payload: { sub: 'write-only-user', scope: 'shopping:write' },
  audience: 'amazon-mcp',
  issuer: 'better-auth',
  expiresIn: '10m',
});
const wrongAudienceToken = generateJWT({
  secret,
  payload: { sub: 'wrong-audience-user', scopes: ['shopping:read', 'shopping:write'] },
  audience: 'another-resource',
  issuer: 'better-auth',
  expiresIn: '10m',
});
const wrongIssuerToken = generateJWT({
  secret,
  payload: { sub: 'wrong-issuer-user', scopes: ['shopping:read', 'shopping:write'] },
  audience: 'amazon-mcp',
  issuer: 'another-issuer',
  expiresIn: '10m',
});
const wrongSignatureToken = generateJWT({
  secret: 'wrong-signing-secret-with-enough-entropy',
  payload: { sub: 'wrong-signature-user', scopes: ['shopping:read', 'shopping:write'] },
  audience: 'amazon-mcp',
  issuer: 'better-auth',
  expiresIn: '10m',
});
const expiredToken = generateJWT({
  secret,
  payload: { sub: 'expired-user', scopes: ['shopping:read', 'shopping:write'] },
  audience: 'amazon-mcp',
  issuer: 'better-auth',
  expiresIn: -1,
});
const authMeta = { _meta: { authorization: `Bearer ${token}` } };
const previousAuthMeta = { _meta: { authorization: `Bearer ${previousToken}` } };
const readOnlyAuthMeta = { _meta: { authorization: `Bearer ${readOnlyToken}` } };
const writeOnlyAuthMeta = { _meta: { authorization: `Bearer ${writeOnlyToken}` } };
const otherAuthMeta = { _meta: { authorization: `Bearer ${otherToken}` } };

try {
  await withTimeout(request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'amazon-mcp-verifier', version: '1.0.0' },
  }), 'initialize');
  notify('notifications/initialized');

  const tools = await withTimeout(request('tools/list'), 'tools/list');
  const toolNames = tools.tools.map((tool) => tool.name);
  assert(JSON.stringify(toolNames) === JSON.stringify(expectedTools), `Unexpected tools: ${toolNames.join(', ')}`);
  for (const tool of tools.tools) {
    assert(tool.inputSchema?.type === 'object', `${tool.name} has no object input schema`);
    assert(tool.examples?.request !== undefined, `${tool.name} is missing request examples`);
    assert(tool.examples?.response !== undefined, `${tool.name} is missing response examples`);
    assert(Array.isArray(tool.outputSchema?.anyOf), `${tool.name} does not advertise the standard output envelope`);

    const meta = tool._meta ?? {};
    assert(meta['ui/template'] === widgetTools[tool.name], `${tool.name} is not linked to ${widgetTools[tool.name]}`);
    assert(meta['openai/outputTemplate'] === widgetTools[tool.name], `${tool.name} is missing the OpenAI output template`);
    if (cspTools.has(tool.name)) {
      const openAiCsp = meta['openai/widgetCSP']?.resource_domains ?? [];
      const mcpCsp = meta.ui?.csp?.resourceDomains ?? [];
      for (const host of ebayImageHosts) {
        assert(openAiCsp.includes(host), `${tool.name} openai/widgetCSP is missing ${host}`);
        assert(mcpCsp.includes(host), `${tool.name} MCP widget CSP is missing ${host}`);
      }
    }
  }

  const addToCartProperties = Object.keys(
    tools.tools.find((tool) => tool.name === 'add_to_cart').inputSchema.properties,
  ).sort();
  assert(
    JSON.stringify(addToCartProperties) === JSON.stringify(['item_id', 'quantity']),
    `add_to_cart still accepts caller-supplied product data: ${addToCartProperties.join(', ')}`,
  );

  const resources = await withTimeout(request('resources/list'), 'resources/list');
  const resourceUris = resources.resources.map((resource) => resource.uri);
  for (const uri of expectedResources) {
    assert(resourceUris.includes(uri), `Missing resource ${uri}`);
  }

  const prompts = await withTimeout(request('prompts/list'), 'prompts/list');
  assert(prompts.prompts.some((prompt) => prompt.name === 'shopping_assistant'), 'Missing shopping_assistant prompt');
  const prompt = await withTimeout(request('prompts/get', {
    name: 'shopping_assistant',
    arguments: { request: 'a compact keyboard' },
  }), 'prompts/get');
  assert(prompt.messages?.length === 2, 'Prompt did not return two messages');

  for (const uri of expectedResources) {
    const read = await withTimeout(request('resources/read', { uri }), `resources/read ${uri}`);
    assert(read.contents?.length > 0, `${uri} returned no contents`);
  }
  const health = await withTimeout(request('resources/read', { uri: 'health://checks' }), 'health read');
  const healthPayload = JSON.parse(health.contents[0].text);
  const healthChecks = Object.fromEntries(healthPayload.checks.map((check) => [check.name, check]));
  assert(healthChecks.database?.status === 'up', `Database health failed: ${JSON.stringify(healthChecks.database)}`);
  assert(healthChecks.ebay?.status === 'degraded', `Expected demo eBay health: ${JSON.stringify(healthChecks.ebay)}`);

  const call = async (name, argumentsValue = {}) => {
    const result = await withTimeout(request('tools/call', { name, arguments: argumentsValue }), `tools/call ${name}`);
    return parseToolResult(result, name);
  };
  const protectedCall = async (name, argumentsValue = {}) => call(name, { ...argumentsValue, ...authMeta });

  const denied = await call('view_cart');
  assert(denied.success === false && denied.error.code === 'UNAUTHORIZED', `Protected tool was not denied: ${JSON.stringify(denied)}`);
  const malformedToken = await call('view_cart', { _meta: { authorization: 'Bearer definitely-not-a-jwt' } });
  assert(malformedToken.success === false && malformedToken.error.code === 'UNAUTHORIZED', `Malformed JWT was not rejected: ${JSON.stringify(malformedToken)}`);
  for (const [label, metadata] of [
    ['wrong audience', { _meta: { authorization: `Bearer ${wrongAudienceToken}` } }],
    ['wrong issuer', { _meta: { authorization: `Bearer ${wrongIssuerToken}` } }],
    ['wrong signature', { _meta: { authorization: `Bearer ${wrongSignatureToken}` } }],
    ['expired', { _meta: { authorization: `Bearer ${expiredToken}` } }],
  ]) {
    const rejected = await call('view_cart', metadata);
    assert(rejected.success === false && rejected.error.code === 'UNAUTHORIZED', `${label} JWT was not rejected: ${JSON.stringify(rejected)}`);
  }
  const rotated = await call('view_cart', previousAuthMeta);
  assert(rotated.success && rotated.data.itemCount === 0, `Previous rotation secret was not accepted: ${JSON.stringify(rotated)}`);
  const readOnlyCart = await call('view_cart', readOnlyAuthMeta);
  assert(readOnlyCart.success, `Read scope was not accepted: ${JSON.stringify(readOnlyCart)}`);
  const readOnlyWrite = await call('add_to_cart', {
    item_id: 'v1|demo-headphones|0',
    quantity: 1,
    ...readOnlyAuthMeta,
  });
  assert(readOnlyWrite.success === false && readOnlyWrite.error.code === 'FORBIDDEN', `Insufficient read-only scope was not rejected: ${JSON.stringify(readOnlyWrite)}`);
  const writeOnlyRead = await call('view_cart', writeOnlyAuthMeta);
  assert(writeOnlyRead.success === false && writeOnlyRead.error.code === 'FORBIDDEN', `Insufficient write-only scope was not rejected: ${JSON.stringify(writeOnlyRead)}`);
  const invalid = await call('search_products', { query: '' });
  assert(invalid.success === false && invalid.error.code === 'BAD_REQUEST', `Invalid input was not rejected: ${JSON.stringify(invalid)}`);

  const search = await call('search_products', { query: 'headphones', limit: 1 });
  assert(search.success && search.data.items.length === 1, `Search failed: ${JSON.stringify(search)}`);
  const item = await call('get_product', { item_id: search.data.items[0].itemId });
  assert(item.success && item.data.itemId === search.data.items[0].itemId, `Product lookup failed: ${JSON.stringify(item)}`);
  const categories = await call('get_categories', { category_id: '0' });
  assert(categories.success && categories.data.root.children.length > 0, 'Category lookup failed');

  const added = await protectedCall('add_to_cart', {
    item_id: item.data.itemId,
    quantity: 2,
    title: item.data.title,
    unit_price: item.data.price,
    currency: item.data.currency,
  });
  assert(added.success && added.data.itemCount === 2, `Add to cart failed: ${JSON.stringify(added)}`);
  const viewed = await protectedCall('view_cart');
  assert(viewed.success && viewed.data.itemCount === 2, `View cart failed: ${JSON.stringify(viewed)}`);
  const updated = await protectedCall('update_cart_item', { item_id: item.data.itemId, quantity: 1 });
  assert(updated.success && updated.data.itemCount === 1, `Update cart failed: ${JSON.stringify(updated)}`);

  const quote = await protectedCall('checkout', {
    shipping_address: {
      recipient_name: 'Verifier',
      line1: '1 Test Street',
      city: 'Testville',
      postal_code: '00000',
      country: 'US',
    },
  });
  assert(quote.success && quote.data.checkoutId && quote.data.total > 0, `Checkout failed: ${JSON.stringify(quote)}`);
  const placed = await protectedCall('place_order', { checkout_id: quote.data.checkoutId });
  assert(placed.success && placed.data.order.status === 'placed', `Place order failed: ${JSON.stringify(placed)}`);
  const orderId = placed.data.order.orderId;
  const otherCart = await call('view_cart', { ...otherAuthMeta });
  assert(otherCart.success && otherCart.data.itemCount === 0, `Cart isolation failed: ${JSON.stringify(otherCart)}`);
  const otherOrder = await call('get_order', { order_id: orderId, ...otherAuthMeta });
  assert(otherOrder.success === false && otherOrder.error.code === 'NOT_FOUND', `Order isolation failed: ${JSON.stringify(otherOrder)}`);
  const order = await protectedCall('get_order', { order_id: orderId });
  assert(order.success && order.data.orderId === orderId, `Get order failed: ${JSON.stringify(order)}`);
  const history = await protectedCall('order_history', { limit: 10 });
  assert(history.success && history.data.count === 1, `Order history failed: ${JSON.stringify(history)}`);
  const cancelled = await protectedCall('cancel_order', { order_id: orderId });
  assert(cancelled.success && cancelled.data.status === 'cancelled', `Cancel order failed: ${JSON.stringify(cancelled)}`);
  const finalCart = await protectedCall('view_cart');
  assert(finalCart.success && finalCart.data.itemCount === 0, `Cart was not cleared: ${JSON.stringify(finalCart)}`);

  // ---------------------------------------------------------------------
  // Negative business flows
  // ---------------------------------------------------------------------
  const featured = await withTimeout(request('resources/read', { uri: 'shopping://featured-products' }), 'featured read');
  const featuredPayload = JSON.parse(featured.contents[0].text);
  assert(featuredPayload.strategy === 'demo_catalog', `Featured products did not use the demo catalog: ${JSON.stringify(featuredPayload).slice(0, 300)}`);
  assert(featuredPayload.items.length > 0, 'Featured products returned no items in demo mode');

  const missingCategory = await call('get_categories', { category_id: 'no-such-category' });
  assert(missingCategory.success === false && missingCategory.error.code === 'NOT_FOUND', `Invalid category was not rejected: ${JSON.stringify(missingCategory)}`);

  const missingProduct = await call('get_product', { item_id: 'no-such-item' });
  assert(missingProduct.success === false && missingProduct.error.code === 'NOT_FOUND', `Invalid item was not rejected: ${JSON.stringify(missingProduct)}`);

  const emptyCheckout = await protectedCall('checkout');
  assert(emptyCheckout.success === false && emptyCheckout.error.code === 'BAD_REQUEST', `Empty checkout was not rejected: ${JSON.stringify(emptyCheckout)}`);

  const unknownItem = await protectedCall('add_to_cart', { item_id: 'no-such-item', quantity: 1 });
  assert(unknownItem.success === false && unknownItem.error.code === 'NOT_FOUND', `Unknown item entered a cart: ${JSON.stringify(unknownItem)}`);

  const forged = await protectedCall('add_to_cart', {
    item_id: item.data.itemId,
    quantity: 1,
    unit_price: 0.01,
    title: 'Forged title',
    currency: 'JPY',
  });
  assert(forged.success, `Add to cart failed: ${JSON.stringify(forged)}`);
  const forgedItem = forged.data.items.find((entry) => entry.itemId === item.data.itemId);
  assert(forgedItem.unitPrice === item.data.price && forgedItem.currency === item.data.currency && forgedItem.title === item.data.title,
    `Caller-supplied product data reached the cart: ${JSON.stringify(forgedItem)}`);

  // The demo catalog advertises 24 units; one is already in the cart above.
  const overStock = await protectedCall('add_to_cart', { item_id: item.data.itemId, quantity: 30 });
  assert(overStock.success === false && overStock.error.code === 'OUT_OF_STOCK', `Over-stock quantity was accepted: ${JSON.stringify(overStock)}`);

  // A quote is bound to the cart it was priced from.
  const staleQuote = await protectedCall('checkout');
  assert(staleQuote.success && staleQuote.data.cartRevision, `Checkout failed: ${JSON.stringify(staleQuote)}`);
  const secondItem = await call('search_products', { query: 'keyboard', limit: 1 });
  const secondItemId = secondItem.data.items[0].itemId;
  const changedCart = await protectedCall('add_to_cart', { item_id: secondItemId, quantity: 1 });
  assert(changedCart.success && changedCart.data.revision !== staleQuote.data.cartRevision, 'Cart revision did not change after a cart change');

  const stalePlacement = await protectedCall('place_order', { checkout_id: staleQuote.data.checkoutId });
  assert(stalePlacement.success === false && stalePlacement.error.code === 'CONFLICT', `A stale quote was placed: ${JSON.stringify(stalePlacement)}`);
  const preservedCart = await protectedCall('view_cart');
  assert(preservedCart.success && preservedCart.data.items.length === 2, `A stale placement destroyed the newer cart: ${JSON.stringify(preservedCart.data)}`);

  const freshQuote = await protectedCall('checkout');
  assert(freshQuote.success, `Fresh checkout failed: ${JSON.stringify(freshQuote)}`);
  const firstPlacement = await protectedCall('place_order', { checkout_id: freshQuote.data.checkoutId });
  assert(firstPlacement.success && firstPlacement.data.alreadyPlaced === false, `Place order failed: ${JSON.stringify(firstPlacement)}`);
  const retriedPlacement = await protectedCall('place_order', { checkout_id: freshQuote.data.checkoutId });
  assert(
    retriedPlacement.success &&
      retriedPlacement.data.alreadyPlaced === true &&
      retriedPlacement.data.order.orderId === firstPlacement.data.order.orderId,
    `Retrying place_order created a second order: ${JSON.stringify(retriedPlacement)}`,
  );

  const otherUserQuote = await call('place_order', { checkout_id: freshQuote.data.checkoutId, ...otherAuthMeta });
  assert(otherUserQuote.success === false && otherUserQuote.error.code === 'NOT_FOUND', `A quote leaked across users: ${JSON.stringify(otherUserQuote)}`);

  const secondOrderId = firstPlacement.data.order.orderId;
  const firstCancel = await protectedCall('cancel_order', { order_id: secondOrderId });
  assert(firstCancel.success, `Cancel failed: ${JSON.stringify(firstCancel)}`);
  const secondCancel = await protectedCall('cancel_order', { order_id: secondOrderId });
  assert(secondCancel.success === false && secondCancel.error.code === 'CONFLICT', `An already-cancelled order was cancelled again: ${JSON.stringify(secondCancel)}`);

  const historyAfter = await protectedCall('order_history', { limit: 50 });
  assert(historyAfter.success && historyAfter.data.count === 2, `Unexpected order history: ${JSON.stringify(historyAfter.data)}`);
  assert(historyAfter.data.orders.every((entry) => entry.fulfillment === 'demo'), 'Orders did not report the demo fulfilment mode');

  const metrics = await withTimeout(request('resources/read', { uri: 'metrics://shopping' }), 'metrics read');
  const metricsPayload = JSON.parse(metrics.contents[0].text);
  assert(metricsPayload.tools.view_cart?.invocations > 0, `Tool metrics were not recorded: ${JSON.stringify(metricsPayload.tools).slice(0, 300)}`);
  assert(metricsPayload.quota.scope === 'process', `Unexpected quota scope: ${metricsPayload.quota.scope}`);
  assert(metricsPayload.quota.remaining < metricsPayload.quota.limit, 'Catalog calls did not consume the eBay budget');
  assert(metricsPayload.cache.catalog.hits + metricsPayload.cache.catalog.misses > 0, 'Catalog cache counters were not recorded');
  assert(metricsPayload.storage.mode === 'memory', `Unexpected storage mode: ${metricsPayload.storage.mode}`);
  assert(!JSON.stringify(metricsPayload).includes(secret), 'Metrics leaked the JWT secret');

  console.log(JSON.stringify({
    status: 'ok',
    tools: toolNames,
    resourcesVerified: expectedResources,
    prompt: 'shopping_assistant',
    orderId,
    orderStatus: cancelled.data.status,
    negativeFlows: [
      'invalid category',
      'invalid product',
      'empty checkout',
      'unknown cart item',
      'forged product snapshot',
      'out-of-stock quantity',
      'cart changed after checkout',
      'duplicate place_order',
      'cross-user quote access',
      'already-cancelled order',
    ],
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  if (stderrBuffer) console.error('\nServer stderr:\n' + stderrBuffer.slice(-12000));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  await delay(100);
  if (child.exitCode === null) child.kill('SIGTERM');
  await delay(200);
  if (child.exitCode === null) child.kill('SIGKILL');
}

process.exit(process.exitCode ?? 0);
