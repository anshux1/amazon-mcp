import assert from 'node:assert/strict';
import test from 'node:test';
import { generateJWT } from '@nitrostack/core';
import {
  extractScopes,
  extractToken,
  getJwtAlgorithm,
  getJwtVerificationSecrets,
  isHmacJwtAlgorithm,
  verifyBetterAuthToken,
} from '../../dist/modules/auth/jwt.guard.js';
import { AuthService } from '../../dist/modules/auth/auth.service.js';
import { makeConfig, makeContext } from '../helpers.mjs';

const secret = 'unit-test-secret-with-enough-entropy';
const previousSecret = 'unit-test-previous-secret-with-entropy';
const baseConfig = {
  JWT_SECRET: secret,
  JWT_AUDIENCE: 'amazon-mcp',
  JWT_ISSUER: 'better-auth',
  JWT_ALGORITHM: 'HS256',
  JWT_MAX_TOKEN_LIFETIME_SECONDS: '3600',
};

const token = (overrides = {}) =>
  generateJWT({
    secret,
    payload: { sub: 'user-1', scopes: ['shopping:read'] },
    audience: 'amazon-mcp',
    issuer: 'better-auth',
    expiresIn: '10m',
    ...overrides,
  });

test('extractToken reads an Authorization header and MCP metadata alike', () => {
  assert.equal(extractToken(makeContext({ metadata: { authorization: 'Bearer abc' } })), 'abc');
  assert.equal(extractToken(makeContext({ metadata: { Authorization: 'bearer abc' } })), 'abc');
  assert.equal(extractToken(makeContext({ metadata: { _meta: { authorization: 'Bearer abc' } } })), 'abc');
  assert.equal(extractToken(makeContext({ metadata: { token: ' abc ' } })), 'abc');
});

test('extractToken rejects a malformed Authorization header', () => {
  assert.equal(extractToken(makeContext({ metadata: { authorization: 'abc' } })), null);
  assert.equal(extractToken(makeContext({ metadata: { authorization: 'Bearer' } })), null);
  assert.equal(extractToken(makeContext({ metadata: { authorization: 'Bearer a b' } })), null);
  assert.equal(extractToken(makeContext({ metadata: {} })), null);
  assert.equal(extractToken(makeContext({ metadata: undefined })), null);
});

test('extractScopes supports both the array and the space-separated claim', () => {
  assert.deepEqual(extractScopes({ scopes: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(extractScopes({ scope: 'a b' }), ['a', 'b']);
  assert.deepEqual(extractScopes({ scopes: ['a'], scope: 'a b' }), ['a', 'b']);
  assert.deepEqual(extractScopes({}), []);
  assert.deepEqual(extractScopes({ scopes: 42 }), []);
});

test('the algorithm allowlist rejects anything unlisted', () => {
  assert.equal(getJwtAlgorithm(makeConfig({ JWT_ALGORITHM: 'ES256' })), 'ES256');
  assert.equal(getJwtAlgorithm(makeConfig({})), 'HS256');
  assert.throws(() => getJwtAlgorithm(makeConfig({ JWT_ALGORITHM: 'none' })), /not allowed/);
  assert.throws(() => getJwtAlgorithm(makeConfig({ JWT_ALGORITHM: 'hs256' })), /not allowed/);
  // Surrounding whitespace is normalized rather than treated as a new algorithm.
  assert.equal(getJwtAlgorithm(makeConfig({ JWT_ALGORITHM: ' HS256 ' })), 'HS256');
  assert.equal(isHmacJwtAlgorithm('HS512'), true);
  assert.equal(isHmacJwtAlgorithm('EdDSA'), false);
});

test('rotation exposes the previous secret and rejects a placeholder', () => {
  assert.deepEqual(getJwtVerificationSecrets(makeConfig({ JWT_SECRET: secret })), [secret]);
  assert.deepEqual(
    getJwtVerificationSecrets(makeConfig({ JWT_SECRET: secret, JWT_SECRET_PREVIOUS: previousSecret })),
    [secret, previousSecret],
  );
  assert.deepEqual(
    getJwtVerificationSecrets(makeConfig({ JWT_SECRET: secret, JWT_SECRET_PREVIOUS: secret })),
    [secret],
  );
  assert.throws(() => getJwtVerificationSecrets(makeConfig({ JWT_SECRET: 'change-me' })), /not configured/);
  assert.throws(() => getJwtVerificationSecrets(makeConfig({})), /not configured/);
});

test('a valid token verifies and yields its subject', async () => {
  const payload = await verifyBetterAuthToken(token(), makeConfig(baseConfig));
  assert.equal(payload.sub, 'user-1');
});

test('a token signed with the previous secret still verifies during rotation', async () => {
  const rotated = generateJWT({
    secret: previousSecret,
    payload: { sub: 'user-2' },
    audience: 'amazon-mcp',
    issuer: 'better-auth',
    expiresIn: '10m',
  });
  const config = makeConfig({ ...baseConfig, JWT_SECRET_PREVIOUS: previousSecret });
  assert.equal((await verifyBetterAuthToken(rotated, config)).sub, 'user-2');
  await assert.rejects(verifyBetterAuthToken(rotated, makeConfig(baseConfig)), /invalid/);
});

const rejections = {
  'wrong audience': token({ audience: 'another-resource' }),
  'wrong issuer': token({ issuer: 'another-issuer' }),
  'wrong signature': token({ secret: 'a-completely-different-secret-value' }),
  expired: token({ expiresIn: -1 }),
  malformed: 'not-a-jwt',
};

for (const [label, value] of Object.entries(rejections)) {
  test(`a ${label} token is rejected`, async () => {
    await assert.rejects(verifyBetterAuthToken(value, makeConfig(baseConfig)), (error) => {
      assert.equal(error.code, 'UNAUTHORIZED');
      return true;
    });
  });
}

test('a token whose lifetime exceeds the server policy is rejected', async () => {
  const longLived = token({ expiresIn: '12h' });
  await assert.rejects(
    verifyBetterAuthToken(longLived, makeConfig({ ...baseConfig, JWT_MAX_TOKEN_LIFETIME_SECONDS: '3600' })),
    /lifetime policy/,
  );
  assert.equal(
    (await verifyBetterAuthToken(longLived, makeConfig({ ...baseConfig, JWT_MAX_TOKEN_LIFETIME_SECONDS: '86400' }))).sub,
    'user-1',
  );
});

test('AuthService refuses to resolve a user without a verified subject', () => {
  const auth = new AuthService();
  assert.equal(auth.getUserId(makeContext({ auth: { subject: 'u1' } })), 'u1');
  assert.throws(() => auth.getUserId(makeContext()), (error) => error.code === 'UNAUTHORIZED');
  assert.deepEqual(auth.getUser(makeContext({ auth: { subject: 'u1', scopes: ['shopping:read'] } })), {
    userId: 'u1',
    scopes: ['shopping:read'],
    claims: {},
  });
});
