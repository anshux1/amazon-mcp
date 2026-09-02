#!/usr/bin/env node

import { createServer } from 'node:http';
import { ConfigService } from '@nitrostack/core';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { clearJwksCache, JWTGuard } from '../dist/modules/auth/jwt.guard.js';

const audience = 'amazon-mcp';
const issuer = 'better-auth';
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function keySet(publicKey, kid) {
  return {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    kid,
    use: 'sig',
  };
}

async function makeToken(privateKey, kid) {
  return new SignJWT({ sub: 'jwks-user', scope: 'shopping:read shopping:write' })
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function main() {
  const first = await generateKeyPair('EdDSA');
  const second = await generateKeyPair('EdDSA');
  let keys = [await keySet(first.publicKey, 'first')];
  const jwksServer = createServer((request, response) => {
    if (request.url !== '/jwks') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' });
    response.end(JSON.stringify({ keys }));
  });
  await new Promise((resolve, reject) => {
    jwksServer.once('error', reject);
    jwksServer.listen(0, '127.0.0.1', resolve);
  });
  const address = jwksServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert(port > 0, 'JWKS test server did not bind a port');

  const config = new ConfigService({
    ignoreEnvFile: true,
    defaults: {
      JWT_ALGORITHM: 'EdDSA',
      JWT_JWKS_URI: `http://127.0.0.1:${port}/jwks`,
      JWT_JWKS_CACHE_MAX_AGE_SECONDS: '600',
      JWT_MAX_TOKEN_LIFETIME_SECONDS: '3600',
      JWT_AUDIENCE: audience,
      JWT_ISSUER: issuer,
    },
  });
  const firstToken = await makeToken(first.privateKey, 'first');
  const guard = new JWTGuard(config);
  const contextFor = (token) => ({
    requestId: 'jwks-test',
    toolName: 'view_cart',
    metadata: { authorization: `Bearer ${token}` },
    logger,
  });

  try {
    await guard.canActivate(contextFor(firstToken));

    // An unknown kid causes jose's remote resolver to refresh the cached JWKS.
    // This models Better Auth's rotationInterval/gracePeriod rollover.
    keys = [await keySet(second.publicKey, 'second')];
    const rolloverContext = contextFor(await makeToken(second.privateKey, 'second'));
    await guard.canActivate(rolloverContext);
    assert(rolloverContext.auth?.subject === 'jwks-user', 'JWKS rollover token was not accepted');

    // A token signed by a key not advertised by the endpoint must fail closed.
    const unknown = await generateKeyPair('EdDSA');
    let rejected = false;
    try {
      await guard.canActivate(contextFor(await makeToken(unknown.privateKey, 'unknown')));
    } catch {
      rejected = true;
    }
    assert(rejected, 'JWT signed by an unknown JWKS key was accepted');

    console.log(JSON.stringify({ status: 'ok', verifier: 'jwks', algorithm: 'EdDSA', rollover: true, unknownKeyRejected: true }));
  } finally {
    clearJwksCache();
    await new Promise((resolve) => jwksServer.close(resolve));
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  },
);
