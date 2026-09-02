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
  'health://checks',
  'widget://examples',
];

const serverEnv = {
  ...process.env,
  NODE_ENV: 'development',
  MCP_TRANSPORT_TYPE: 'stdio',
  NITROSTACK_APP_MODE: 'universal',
  DATABASE_FILE: ':memory:',
  EBAY_MOCK: 'true',
  JWT_SECRET: secret,
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
const authMeta = { _meta: { authorization: `Bearer ${token}` } };
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
  }

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

  console.log(JSON.stringify({
    status: 'ok',
    tools: toolNames,
    resourcesVerified: expectedResources,
    prompt: 'shopping_assistant',
    orderId,
    orderStatus: cancelled.data.status,
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
