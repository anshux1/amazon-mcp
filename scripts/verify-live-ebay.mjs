#!/usr/bin/env node

/**
 * Live eBay integration verification (credential-gated).
 *
 * Skips unless EBAY_APP_ID and EBAY_CERT_ID are set. Point it at the eBay
 * sandbox (EBAY_SANDBOX=true) unless you deliberately want to spend production
 * Browse API budget: every check here consumes the daily application quota.
 *
 *   EBAY_APP_ID=... EBAY_CERT_ID=... EBAY_SANDBOX=true node scripts/verify-live-ebay.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const appId = process.env.EBAY_APP_ID?.trim();
const certId = process.env.EBAY_CERT_ID?.trim();
const query = process.env.EBAY_TEST_QUERY?.trim() || 'wireless headphones';

if (!appId || !certId) {
  console.log(JSON.stringify({
    status: 'skipped',
    reason: 'Set EBAY_APP_ID and EBAY_CERT_ID to run the live eBay integration checks',
  }));
  process.exit(0);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer(extraEnv = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    MCP_TRANSPORT_TYPE: 'stdio',
    NITROSTACK_APP_MODE: 'universal',
    DATABASE_FILE: ':memory:',
    EBAY_MOCK: 'false',
    JWT_SECRET: 'live-verify-secret-with-enough-entropy',
    PORT: '0',
    ...extraEnv,
  };
  delete env.DATABASE_URL;

  const child = spawn(process.execPath, [serverPath], { cwd: projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  });

  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Timed out waiting for ${method}\n${stderr.slice(-2000)}`));
      }, 30000).unref();
    });
  };

  const call = async (name, argumentsValue = {}) => {
    const result = await request('tools/call', { name, arguments: argumentsValue });
    const text = result?.content?.find((entry) => entry.type === 'text')?.text;
    if (!text) throw new Error(`${name} returned no text content`);
    return JSON.parse(text);
  };

  const ready = request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'amazon-mcp-live-verifier', version: '1.0.0' },
  }).then(() => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  });

  return {
    ready,
    request,
    call,
    getStderr: () => stderr,
    stop() {
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

async function main() {
  const sandbox = process.env.EBAY_SANDBOX?.trim().toLowerCase() === 'true';
  const server = startServer();
  const findings = {};

  try {
    await server.ready;

    // -- Browse: search -------------------------------------------------
    const search = await server.call('search_products', { query, limit: 5, offset: 0 });
    assert(search.success, `Live search failed: ${JSON.stringify(search.error)}`);
    assert(search.data.source === 'ebay', `Search did not use the live catalog: ${search.data.source}`);
    assert(search.data.limit === 5 && search.data.offset === 0, 'Pagination parameters were not echoed back');
    assert(search.data.items.length > 0, 'Live search returned no items; try a different EBAY_TEST_QUERY');

    for (const item of search.data.items) {
      assert(typeof item.itemId === 'string' && item.itemId.length > 0, 'A search result has no item ID');
      assert(typeof item.title === 'string' && item.title.length > 0, 'A search result has no title');
      assert(typeof item.price === 'number' && Number.isFinite(item.price), `Item ${item.itemId} has a non-numeric price`);
      assert(/^[A-Z]{3}$/.test(item.currency), `Item ${item.itemId} has an unexpected currency: ${item.currency}`);
      assert(
        item.availableQuantity === null || item.availableQuantity === undefined || item.availableQuantity >= 0,
        `Item ${item.itemId} has a negative availability`,
      );
    }
    findings.search = {
      total: search.data.total,
      returned: search.data.items.length,
      currencies: [...new Set(search.data.items.map((item) => item.currency))],
      withImage: search.data.items.filter((item) => item.imageUrl).length,
      withSeller: search.data.items.filter((item) => item.seller?.username).length,
      withCondition: search.data.items.filter((item) => item.condition).length,
    };

    const page = await server.call('search_products', { query, limit: 5, offset: 5 });
    assert(page.success, `Paginated search failed: ${JSON.stringify(page.error)}`);
    const firstIds = new Set(search.data.items.map((item) => item.itemId));
    assert(
      page.data.items.every((item) => !firstIds.has(item.itemId)),
      'The second page repeated items from the first page',
    );

    const sorted = await server.call('search_products', { query, limit: 10, sort: 'price' });
    assert(sorted.success, `Sorted search failed: ${JSON.stringify(sorted.error)}`);
    const prices = sorted.data.items.map((item) => item.price);
    assert(
      prices.every((price, index) => index === 0 || prices[index - 1] <= price),
      `sort=price did not return ascending prices: ${prices.join(', ')}`,
    );

    const categoryId = search.data.items.find((item) => item.categoryId)?.categoryId;
    if (categoryId) {
      const filtered = await server.call('search_products', { query, limit: 5, category_id: categoryId });
      assert(filtered.success, `Category-filtered search failed: ${JSON.stringify(filtered.error)}`);
      findings.categoryFilter = { categoryId, returned: filtered.data.items.length };
    }

    // -- Browse: item ---------------------------------------------------
    const itemId = search.data.items[0].itemId;
    const product = await server.call('get_product', { item_id: itemId });
    assert(product.success && product.data.itemId === itemId, `Live get_product failed: ${JSON.stringify(product.error)}`);
    assert(Array.isArray(product.data.additionalImageUrls), 'get_product did not normalize additional images');
    assert(Array.isArray(product.data.buyingOptions), 'get_product did not normalize buying options');
    assert(typeof product.data.lastUpdated === 'string', 'get_product did not stamp lastUpdated');
    findings.item = {
      itemId,
      currency: product.data.currency,
      hasShipping: product.data.shipping !== undefined,
      availableQuantity: product.data.availableQuantity,
    };

    const missingItem = await server.call('get_product', { item_id: 'v1|000000000000|0' });
    assert(
      missingItem.success === false && ['NOT_FOUND', 'EXTERNAL_SERVICE_ERROR'].includes(missingItem.error.code),
      `An invalid item ID produced an unexpected result: ${JSON.stringify(missingItem)}`,
    );
    assert(!JSON.stringify(missingItem).includes(certId), 'An eBay error leaked the certificate ID');
    assert(!JSON.stringify(missingItem).includes(appId), 'An eBay error leaked the application ID');

    // -- Taxonomy -------------------------------------------------------
    const tree = await server.call('get_categories', { category_id: '0' });
    assert(tree.success, `Live category tree failed: ${JSON.stringify(tree.error)}`);
    assert(tree.data.root.children.length > 0, 'The default category tree returned no children');
    const serializedTree = JSON.stringify(tree.data);
    assert(serializedTree.length < 1_000_000, `The category tree response is ${serializedTree.length} bytes; tighten EBAY_CATEGORY_MAX_DEPTH`);
    findings.categories = {
      treeId: tree.data.treeId,
      rootChildren: tree.data.root.children.length,
      truncated: tree.data.truncated,
      depth: tree.data.depth,
      bytes: serializedTree.length,
    };

    const subtreeId = tree.data.root.children[0].categoryId;
    const subtree = await server.call('get_categories', { category_id: subtreeId });
    assert(subtree.success && subtree.data.root.categoryId === subtreeId, `Category subtree failed: ${JSON.stringify(subtree.error)}`);

    const missingCategory = await server.call('get_categories', { category_id: '999999999' });
    assert(
      missingCategory.success === false && ['NOT_FOUND', 'EXTERNAL_SERVICE_ERROR'].includes(missingCategory.error.code),
      `An invalid category ID produced an unexpected result: ${JSON.stringify(missingCategory)}`,
    );

    // -- Health and quota ------------------------------------------------
    const health = await server.request('resources/read', { uri: 'health://checks' });
    const healthPayload = JSON.parse(health.contents[0].text);
    const ebayCheck = healthPayload.checks.find((check) => check.name === 'ebay');
    assert(['up', 'degraded'].includes(ebayCheck.status), `eBay health reported ${ebayCheck.status}`);
    assert(ebayCheck.details.configured === true, 'eBay health did not report a configured dependency');
    assert(ebayCheck.details.sandbox === sandbox, `EBAY_SANDBOX=${sandbox} was not honoured by the client`);

    const metrics = await server.request('resources/read', { uri: 'metrics://shopping' });
    const metricsPayload = JSON.parse(metrics.contents[0].text);
    assert(metricsPayload.ebay.totalRequests > 0, 'No live eBay requests were recorded');
    const serializedMetrics = JSON.stringify(metricsPayload);
    assert(!serializedMetrics.includes(certId) && !serializedMetrics.includes(appId), 'Metrics leaked eBay credentials');
    findings.metrics = {
      requests: metricsPayload.ebay.totalRequests,
      failures: metricsPayload.ebay.totalFailures,
      quotaRemaining: metricsPayload.quota.remaining,
      cache: metricsPayload.cache.catalog,
    };

    const logs = server.getStderr();
    assert(!logs.includes(certId), 'The server log contains the eBay certificate ID');
  } finally {
    server.stop();
  }

  // -- Invalid credentials fail closed and stay quiet --------------------
  const broken = startServer({ EBAY_APP_ID: 'invalid-app-id', EBAY_CERT_ID: 'invalid-cert-id' });
  try {
    await broken.ready;
    const result = await broken.call('search_products', { query: 'anything', limit: 1 });
    assert(result.success === false, 'Invalid eBay credentials produced a successful search');
    assert(
      ['EXTERNAL_SERVICE_ERROR', 'RATE_LIMITED'].includes(result.error.code),
      `Unexpected error for invalid credentials: ${JSON.stringify(result.error)}`,
    );
    assert(!JSON.stringify(result).includes('invalid-cert-id'), 'An authentication failure echoed the certificate ID');
    findings.invalidCredentials = result.error.code;
  } finally {
    broken.stop();
  }

  console.log(JSON.stringify({ status: 'ok', sandbox, query, findings }, null, 2));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  },
);
