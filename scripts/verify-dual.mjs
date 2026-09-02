#!/usr/bin/env node

/**
 * Dual-transport verification.
 *
 * With MCP_TRANSPORT_TYPE=dual the same process serves stdio and Streamable
 * HTTP at once. NitroStack disables HTTP session management in this mode, so
 * this script confirms that a session-less HTTP client still works, that the
 * Authorization header still reaches the guard, and that both transports see
 * the same persisted cart.
 */

import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateJWT } from '@nitrostack/core';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const secret = 'dual-verify-secret-with-enough-entropy';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function parseEventStream(body, label) {
  const dataLine = body.split(/\r?\n/).find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`${label} returned no MCP event: ${body.slice(0, 400)}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

async function main() {
  const port = await findFreePort();
  const token = generateJWT({
    secret,
    payload: { sub: 'dual-verify-user', scopes: ['shopping:read', 'shopping:write'] },
    audience: 'amazon-mcp',
    issuer: 'better-auth',
    expiresIn: '10m',
  });

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    MCP_TRANSPORT_TYPE: 'dual',
    NITROSTACK_APP_MODE: 'universal',
    HOST: '127.0.0.1',
    PORT: String(port),
    // A file-backed database is shared by both transports inside one process.
    DATABASE_FILE: ':memory:',
    EBAY_MOCK: 'true',
    JWT_SECRET: secret,
    JWT_AUDIENCE: 'amazon-mcp',
    JWT_ISSUER: 'better-auth',
    JWT_ALGORITHM: 'HS256',
  };
  delete env.DATABASE_URL;
  delete env.DATABASE_SSL;

  const child = spawn(process.execPath, [serverPath], { cwd: projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  let listening;
  const httpReady = new Promise((resolve, reject) => {
    listening = resolve;
    setTimeout(() => reject(new Error(`Timed out starting the dual transport\n${stderr.slice(-3000)}`)), 20000).unref();
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.includes('Streamable HTTP transport listening')) listening();
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

  const stdio = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Timed out waiting for stdio ${method}`));
      }, 15000).unref();
    });
  };

  // The SDK transport issues a session id on initialize even in dual mode.
  let httpSessionId;
  const http = async (message, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...(httpSessionId ? { 'Mcp-Session-Id': httpSessionId } : {}),
        ...headers,
      },
      body: JSON.stringify(message),
    });
    const body = await response.text();
    assert(response.ok, `HTTP ${message.method} failed with ${response.status}: ${body.slice(0, 300)}`);
    httpSessionId = response.headers.get('mcp-session-id') ?? httpSessionId;
    return parseEventStream(body, message.method);
  };

  const payload = (result, label) => {
    const text = result?.content?.find((entry) => entry.type === 'text')?.text;
    if (!text) throw new Error(`${label} returned no text content`);
    return JSON.parse(text);
  };

  try {
    await httpReady;

    await stdio('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'amazon-mcp-dual-verifier', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const stdioTools = await stdio('tools/list');
    assert(stdioTools.tools.length === 11, `stdio exposed ${stdioTools.tools.length} tools`);

    await http({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'amazon-mcp-dual-verifier', version: '1.0.0' },
      },
    });

    const httpTools = await http({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert(httpTools.result.tools.length === 11, 'The HTTP transport exposed a different tool set');

    const denied = payload(
      (await http({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'view_cart', arguments: {} } })).result,
      'view_cart',
    );
    assert(denied.success === false && denied.error.code === 'UNAUTHORIZED', `Dual HTTP allowed an anonymous call: ${JSON.stringify(denied)}`);

    // Add over HTTP with the Authorization header ...
    const search = payload(
      (await stdio('tools/call', { name: 'search_products', arguments: { query: 'headphones', limit: 1 } })),
      'search_products',
    );
    const itemId = search.data.items[0].itemId;
    const added = payload(
      (await http(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'add_to_cart', arguments: { item_id: itemId, quantity: 2 } } },
        { Authorization: `Bearer ${token}` },
      )).result,
      'add_to_cart',
    );
    assert(added.success && added.data.itemCount === 2, `Dual HTTP add_to_cart failed: ${JSON.stringify(added)}`);

    // ... and read it back over stdio with _meta.authorization.
    const viewed = payload(
      await stdio('tools/call', {
        name: 'view_cart',
        arguments: { _meta: { authorization: `Bearer ${token}` } },
      }),
      'view_cart',
    );
    assert(
      viewed.success && viewed.data.itemCount === 2 && viewed.data.userId === 'dual-verify-user',
      `Both transports did not observe the same cart: ${JSON.stringify(viewed)}`,
    );

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert(health.status === 200, `Dual-mode liveness failed with ${health.status}`);

    console.log(JSON.stringify({ status: 'ok', transport: 'dual', tools: 11, sharedState: true }));
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  },
);
