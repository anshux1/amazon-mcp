#!/usr/bin/env node

/**
 * Widget protocol verification.
 *
 * Reads every widget resource through MCP (not from the static export on disk)
 * in each supported protocol mode, and checks that the mode-specific MIME type
 * and tool metadata are the ones the target client expects:
 *
 *   openai   → text/html, openai/outputTemplate, openai/widgetCSP
 *   mcp-app  → text/html;profile=mcp-app, ui/template, _meta.ui.csp
 *   universal→ both, without emitting a MIME type neither host understands
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const widgetResources = [
  'ui://widget/next-product-search-results.html',
  'ui://widget/next-product-card.html',
  'ui://widget/next-category-tree.html',
  'ui://widget/next-cart-summary.html',
  'ui://widget/next-order-confirmation.html',
  'ui://widget/next-order-summary.html',
  'ui://widget/next-order-cancellation.html',
];

const ebayImageHosts = [
  'https://i.ebayimg.com',
  'https://*.ebayimg.com',
  'https://secureir.ebaystatic.com',
  'https://*.ebaystatic.com',
];

const MCP_APP_MIME = 'text/html;profile=mcp-app';
const OPENAI_MIME = 'text/html';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withServer(appMode, run) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    MCP_TRANSPORT_TYPE: 'stdio',
    NITROSTACK_APP_MODE: appMode,
    DATABASE_FILE: ':memory:',
    EBAY_MOCK: 'true',
    JWT_SECRET: 'widget-verify-secret-with-enough-entropy',
    PORT: '0',
  };
  delete env.DATABASE_URL;
  delete env.DATABASE_SSL;

  const child = spawn(process.execPath, [serverPath], { cwd: projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
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
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result);
    }
  });

  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`Timed out waiting for ${method} in ${appMode} mode\n${stderrBuffer.slice(-2000)}`));
        }
      }, 15000).unref();
    });
  };

  try {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'amazon-mcp-widget-verifier', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return await run(request);
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
}

async function checkMode(appMode) {
  return withServer(appMode, async (request) => {
    const mcpApp = appMode === 'mcp-app' || appMode === 'universal';
    const openai = appMode === 'openai' || appMode === 'universal';
    const expectedMime = mcpApp ? MCP_APP_MIME : OPENAI_MIME;

    const resources = await request('resources/list');
    const byUri = new Map(resources.resources.map((resource) => [resource.uri, resource]));
    for (const uri of widgetResources) {
      const listed = byUri.get(uri);
      assert(listed, `${appMode}: ${uri} was not listed`);
      assert(
        listed.mimeType === expectedMime,
        `${appMode}: ${uri} was listed as ${listed.mimeType}, expected ${expectedMime}`,
      );

      // Read through MCP rather than from src/widgets/out, so the transport,
      // the resource registration, and the exported HTML are all exercised.
      const read = await request('resources/read', { uri });
      const contents = read.contents?.[0];
      assert(contents, `${appMode}: ${uri} returned no contents`);
      assert(
        contents.mimeType === expectedMime,
        `${appMode}: ${uri} was read as ${contents.mimeType}, expected ${expectedMime}`,
      );
      assert(
        typeof contents.text === 'string' && contents.text.includes('<html'),
        `${appMode}: ${uri} did not return an HTML document`,
      );
      assert(contents.text.length > 500, `${appMode}: ${uri} returned a suspiciously small document`);
    }

    const tools = await request('tools/list');
    const product = tools.tools.find((tool) => tool.name === 'get_product');
    const meta = product._meta ?? {};

    if (openai) {
      assert(
        meta['openai/outputTemplate'] === 'ui://widget/next-product-card.html',
        `${appMode}: openai/outputTemplate is missing`,
      );
      for (const host of ebayImageHosts) {
        assert(
          (meta['openai/widgetCSP']?.resource_domains ?? []).includes(host),
          `${appMode}: openai/widgetCSP is missing ${host}`,
        );
      }
    } else {
      assert(meta['openai/outputTemplate'] === undefined, `${appMode}: openai output template leaked into mcp-app mode`);
      assert(meta['openai/widgetCSP'] === undefined, `${appMode}: openai widget CSP leaked into mcp-app mode`);
    }

    // `ui/template` is NitroStack's mode-independent link. Only the MCP Apps
    // `_meta.ui` object is gated on the mode.
    assert(meta['ui/template'] === 'ui://widget/next-product-card.html', `${appMode}: ui/template is missing`);
    if (mcpApp) {
      assert(meta.ui?.resourceUri === 'ui://widget/next-product-card.html', `${appMode}: _meta.ui is missing`);
      for (const host of ebayImageHosts) {
        assert((meta.ui?.csp?.resourceDomains ?? []).includes(host), `${appMode}: MCP widget CSP is missing ${host}`);
      }
    } else {
      assert(meta.ui === undefined, `${appMode}: MCP Apps _meta.ui leaked into openai mode`);
    }

    return { appMode, mimeType: expectedMime, widgets: widgetResources.length };
  });
}

async function main() {
  const results = [];
  for (const appMode of ['openai', 'mcp-app', 'universal']) {
    results.push(await checkMode(appMode));
  }
  console.log(JSON.stringify({ status: 'ok', modes: results }, null, 2));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  },
);
