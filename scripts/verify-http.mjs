#!/usr/bin/env node

import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateJWT } from '@nitrostack/core';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const secret = 'verify-secret-with-enough-entropy';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error('Could not find a free port')));
    });
  });
}

function parseEventStream(body, label) {
  const dataLine = body.split(/\r?\n/).find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`${label} returned no MCP event: ${body.slice(0, 500)}`);
  try {
    return JSON.parse(dataLine.slice('data: '.length));
  } catch (error) {
    throw new Error(`${label} returned invalid MCP event: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const port = await findFreePort();
  const token = generateJWT({
    secret,
    payload: { sub: 'http-verify-user', scopes: ['shopping:read', 'shopping:write'] },
    audience: 'amazon-mcp',
    issuer: 'better-auth',
    expiresIn: '10m',
  });
  const childEnv = {
    ...process.env,
    NODE_ENV: 'development',
    MCP_TRANSPORT_TYPE: 'http',
    NITROSTACK_APP_MODE: 'universal',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: ':memory:',
    EBAY_MOCK: 'true',
    JWT_SECRET: secret,
    JWT_AUDIENCE: 'amazon-mcp',
    JWT_ISSUER: 'better-auth',
    JWT_ALGORITHM: 'HS256',
    TRUSTED_FORWARDED_HOSTS: 'mcp.example.com',
    MCP_SESSION_TIMEOUT_MS: '600000',
    MCP_MAX_SESSIONS: '50',
    HEALTH_DETAILS: 'true',
  };
  delete childEnv.DATABASE_URL;
  delete childEnv.DATABASE_SSL;

  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let startupResolve;
  let startupReject;
  const startup = new Promise((resolve, reject) => {
    startupResolve = resolve;
    startupReject = reject;
  });
  const startupTimer = setTimeout(() => startupReject(new Error('Timed out waiting for HTTP MCP server')), 15000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.includes('Streamable HTTP transport listening')) {
      clearTimeout(startupTimer);
      startupResolve();
    }
  });
  child.on('error', startupReject);
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      startupReject(new Error(`HTTP MCP server exited (${code}/${signal ?? 'none'})\n${stderr.slice(-6000)}`));
    }
  });

  const endpoint = `http://127.0.0.1:${port}/mcp`;
  async function request(message, headers = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(message),
    });
    const body = await response.text();
    assert(response.ok, `HTTP ${message.method} failed with ${response.status}: ${body}`);
    return { event: parseEventStream(body, message.method), sessionId: response.headers.get('mcp-session-id') };
  }

  async function rawRequest(message, headers = {}, method = 'POST') {
    const response = await fetch(endpoint, {
      method,
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(message ? { body: JSON.stringify(message) } : {}),
    });
    return { status: response.status, body: await response.text(), headers: response.headers };
  }

  async function initialize(headers = {}) {
    const result = await request({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e6),
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'amazon-mcp-http-verifier', version: '1.0.0' },
      },
    }, headers);
    assert(result.sessionId, 'HTTP initialize did not return Mcp-Session-Id');
    return result.sessionId;
  }

  try {
    await startup;

    const anonymousInit = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'amazon-mcp-http-verifier', version: '1.0.0' },
      },
    });
    const anonymousSession = anonymousInit.sessionId;
    assert(anonymousSession, 'HTTP initialize did not return Mcp-Session-Id');
    const denied = await request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'view_cart', arguments: {} },
    }, { 'Mcp-Session-Id': anonymousSession });
    const deniedPayload = JSON.parse(denied.event.result.content[0].text);
    assert(deniedPayload.success === false && deniedPayload.error.code === 'UNAUTHORIZED', `HTTP request without auth was not denied: ${JSON.stringify(deniedPayload)}`);

    const authenticatedInit = await request({
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'amazon-mcp-http-verifier', version: '1.0.0' },
      },
    });
    const authenticatedSession = authenticatedInit.sessionId;
    assert(authenticatedSession, 'Authenticated HTTP initialize did not return Mcp-Session-Id');
    const authenticated = await request({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'view_cart', arguments: {} },
    }, {
      'Mcp-Session-Id': authenticatedSession,
      Authorization: `Bearer ${token}`,
    });
    const authenticatedPayload = JSON.parse(authenticated.event.result.content[0].text);
    assert(authenticatedPayload.success && authenticatedPayload.data.userId === 'http-verify-user', `HTTP Authorization header was not bridged to JWTGuard: ${JSON.stringify(authenticatedPayload)}`);

    // -------------------------------------------------------------------
    // Deployment endpoints
    // -------------------------------------------------------------------
    const liveness = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert(liveness.status === 200, `Liveness probe failed with ${liveness.status}`);
    const livenessBody = await liveness.json();
    assert(livenessBody.status === 'alive', `Unexpected liveness payload: ${JSON.stringify(livenessBody)}`);

    const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
    const readinessBody = await readiness.json();
    assert(readiness.status === 200 && readinessBody.ready === true, `Readiness probe failed: ${readiness.status} ${JSON.stringify(readinessBody)}`);
    assert(readinessBody.checks.database === 'up', `Readiness did not report the database: ${JSON.stringify(readinessBody)}`);
    assert(readinessBody.checks.ebay === 'demo', `Readiness did not report the eBay mode: ${JSON.stringify(readinessBody)}`);
    assert(readinessBody.details?.storageMode === 'memory', 'HEALTH_DETAILS=true did not expose the storage mode');

    const transportHealth = await fetch(`http://127.0.0.1:${port}/mcp/health`);
    const transportHealthBody = await transportHealth.json();
    assert(transportHealthBody.status === 'ok', `Transport health failed: ${JSON.stringify(transportHealthBody)}`);

    // -------------------------------------------------------------------
    // Protocol-level negative paths
    // -------------------------------------------------------------------
    const malformed = await rawRequest({ jsonrpc: '2.0', id: 99 }, { 'Mcp-Session-Id': authenticatedSession });
    assert(malformed.status >= 400 || malformed.body.includes('error'), `A malformed JSON-RPC message was accepted: ${malformed.status} ${malformed.body.slice(0, 200)}`);

    const noSession = await rawRequest({ jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} });
    assert(noSession.status >= 400 || noSession.body.includes('error'), `A request without a session id was accepted: ${noSession.status} ${noSession.body.slice(0, 200)}`);

    const unknownSession = await rawRequest(
      { jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} },
      { 'Mcp-Session-Id': 'not-a-real-session' },
    );
    assert(unknownSession.status >= 400 || unknownSession.body.includes('error'), 'An unknown session id was accepted');

    // -------------------------------------------------------------------
    // Reverse-proxy header policy
    // -------------------------------------------------------------------
    const untrustedHost = await rawRequest(
      { jsonrpc: '2.0', id: 102, method: 'tools/list', params: {} },
      { 'Mcp-Session-Id': authenticatedSession, 'X-Forwarded-Host': 'attacker.example.com' },
    );
    assert(untrustedHost.status === 403, `An untrusted X-Forwarded-Host was accepted: ${untrustedHost.status}`);

    const trustedHost = await rawRequest(
      { jsonrpc: '2.0', id: 103, method: 'tools/list', params: {} },
      { 'Mcp-Session-Id': authenticatedSession, 'X-Forwarded-Host': 'mcp.example.com' },
    );
    assert(trustedHost.status === 200, `An allowlisted X-Forwarded-Host was rejected: ${trustedHost.status}`);

    const foreignOrigin = await rawRequest(
      { jsonrpc: '2.0', id: 104, method: 'tools/list', params: {} },
      { 'Mcp-Session-Id': authenticatedSession, Origin: 'https://evil.example.com' },
    );
    assert(foreignOrigin.status === 403, `A cross-origin browser request was accepted while CORS is disabled: ${foreignOrigin.status}`);

    // -------------------------------------------------------------------
    // Session lifecycle
    // -------------------------------------------------------------------
    const disposableSession = await initialize();
    const terminated = await rawRequest(null, { 'Mcp-Session-Id': disposableSession }, 'DELETE');
    assert(terminated.status < 400, `Session termination failed with ${terminated.status}`);
    const afterTermination = await rawRequest(
      { jsonrpc: '2.0', id: 105, method: 'tools/list', params: {} },
      { 'Mcp-Session-Id': disposableSession },
    );
    assert(
      afterTermination.status >= 400 || afterTermination.body.includes('error'),
      'A terminated session still accepted requests',
    );

    // -------------------------------------------------------------------
    // Legacy HTTP+SSE clients
    // -------------------------------------------------------------------
    const legacyController = new AbortController();
    const legacy = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { Accept: 'text/event-stream' },
      signal: legacyController.signal,
    });
    assert(legacy.status === 200, `Legacy SSE endpoint failed with ${legacy.status}`);
    assert(
      legacy.headers.get('content-type')?.includes('text/event-stream'),
      `Legacy SSE returned ${legacy.headers.get('content-type')}`,
    );
    legacyController.abort();

    console.log(JSON.stringify({
      status: 'ok',
      transport: 'http',
      authorization: 'header',
      deniedWithoutAuth: true,
      liveness: '/healthz',
      readiness: '/readyz',
      checked: [
        'malformed request',
        'missing session',
        'unknown session',
        'session termination',
        'forwarded-host allowlist',
        'cross-origin rejection',
        'legacy SSE',
      ],
    }));
  } finally {
    clearTimeout(startupTimer);
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null) child.kill('SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  },
);
