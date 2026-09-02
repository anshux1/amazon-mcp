# Shopping MCP Server

A production-oriented shopping MCP server built with **NitroStack**. It exposes an eBay-backed product catalog, authenticated carts and orders, health resources, prompts, and seven static-export widgets.

> `place_order` records an order in this service. It does not charge a payment method or create an eBay fulfillment order. Add a payment/fulfillment provider before using it for real commerce.

## Features

- eBay Browse search, item details, and Taxonomy category trees
- Offline demo catalog for local development (`EBAY_MOCK=true`)
- JWT authentication compatible with a Better Auth JWT plugin
- User-scoped cart and order persistence
- Postgres/Neon in production, atomic JSON-file storage locally, and `:memory:` test mode
- Live price and availability verification during checkout
- Expiring checkout quotes, order history, and cancellation
- Zod input validation, normalized inputs, typed domain errors, structured responses, logging, caching, and eBay quota protection
- Database, eBay, and system health checks exposed as `health://checks`
- Product, cart, and order resources plus the `shopping_assistant` prompt
- Product, search-results, category-tree, cart-summary, confirmation, order-summary, and cancellation widgets

## Requirements

- Node.js 22+
- pnpm 11+
- eBay application credentials for live catalog access (optional for demo mode)
- Postgres/Neon `DATABASE_URL` for multi-instance production persistence

## Quick start

```bash
pnpm install:all
cp .env.example .env
pnpm verify
pnpm dev
```

`pnpm verify` builds the server and widgets, starts an isolated stdio MCP server, and exercises tool schemas, resources, prompt execution, JWT authorization, catalog lookup, cart updates, checkout, order placement, history, cancellation, and cart isolation.

## Configuration

Copy `.env.example` and set values for the deployment. Important settings:

| Variable | Purpose |
| --- | --- |
| `JWT_ALGORITHM` / `JWT_JWKS_URI` | Explicit signing algorithm and Better Auth JWKS endpoint (`EdDSA` + `/api/auth/jwks` by default) |
| `JWT_SECRET` / `JWT_SECRET_PREVIOUS` | Current and temporary previous HMAC secrets; required only for HS* verification and at least 32 bytes outside development |
| `JWT_AUDIENCE` / `JWT_ISSUER` | Required JWT claim validation values (`amazon-mcp` / `better-auth` in the example) |
| `JWT_EXPIRES_IN` / `JWT_MAX_TOKEN_LIFETIME_SECONDS` | Issuer token lifetime and maximum accepted `exp - iat` lifetime (default `3600`) |
| `JWT_JWKS_CACHE_MAX_AGE_SECONDS` | Maximum age of cached public keys before refresh (default `600`) |
| `DATABASE_URL` | Postgres/Neon connection string; required outside development and takes precedence over file storage |
| `DATABASE_FILE` | Single-process local JSON store, or `:memory:` for tests; not a production fallback |
| `EBAY_APP_ID` / `EBAY_CERT_ID` | eBay keyset for live Browse/Taxonomy calls |
| `EBAY_MARKETPLACE_ID` | eBay marketplace, default `EBAY_US` |
| `EBAY_MOCK` | Set `true` to explicitly enable the deterministic offline catalog |
| `MCP_TRANSPORT_TYPE` | `stdio`, `http`, or `dual`; omitted development defaults to `stdio`, omitted production defaults to `http` |
| `PORT` / `HOST` | HTTP listener settings; production defaults to `3000` / `0.0.0.0` when omitted |
| `ENABLE_CORS` / `CORS_ALLOWED_ORIGINS` | CORS opt-in and exact comma-separated HTTP(S) origin allowlist; wildcard origins are rejected |
| `SHOPPING_TAX_RATE` | Decimal tax rate used in checkout, for example `0.0725` |
| `SHOPPING_FULFILLMENT_MODE` | Must be set explicitly outside development; only `demo` is implemented and `external` refuses to start |
| `SHOPPING_QUOTE_TTL_SECONDS` | Checkout quote lifetime, default `600` |
| `SHOPPING_FEATURED_ITEM_IDS` / `SHOPPING_FEATURED_QUERY` | Curated item list, or the fixed query used by `shopping://featured-products` |
| `EBAY_MAX_RETRIES` / `EBAY_RETRY_BASE_MS` | Bounded exponential backoff for transient eBay failures only |
| `EBAY_CATEGORY_MAX_DEPTH` / `EBAY_CATEGORY_MAX_NODES` | Bound a taxonomy response so a full tree cannot overflow a client |
| `EBAY_QUOTA_FALLBACK` | `reject` (default) or `local` when the shared quota counter is unreachable |
| `TRUSTED_FORWARDED_HOSTS` / `REQUIRE_HTTPS` | Reverse-proxy header policy; an `X-Forwarded-Host` outside the allowlist is rejected |
| `HEALTH_DETAILS` | Include storage mode and applied migrations in `/readyz` |
| `OAUTH_ENABLED` | Advertise OAuth 2.1 discovery metadata for external MCP clients |

In development, missing eBay credentials are allowed for the offline demo. Outside development, set `EBAY_MOCK=true` to explicitly allow demo mode, or set `EBAY_MOCK=false` and provide both eBay credentials. A production configuration never silently falls back to the demo catalog. Monitor `health://checks` for the configured eBay status.

## MCP surface

### Tools

| Tool | Auth | Description |
| --- | --- | --- |
| `search_products` | Public | Search the eBay catalog |
| `get_product` | Public | Read current item details |
| `get_categories` | Public | Read the marketplace category tree or subtree |
| `add_to_cart` | JWT + `shopping:write` | Add or increment a user cart item |
| `view_cart` | JWT + `shopping:read` | Read the authenticated user cart |
| `update_cart_item` | JWT + `shopping:write` | Set quantity; `0` removes the item |
| `checkout` | JWT + `shopping:write` | Create a ten-minute quote with live price/availability checks |
| `place_order` | JWT + `shopping:write` | Persist an order from an unexpired quote and clear the cart |
| `get_order` | JWT + `shopping:read` | Read one order owned by the authenticated user |
| `order_history` | JWT + `shopping:read` | List the authenticated user’s orders |
| `cancel_order` | JWT + `shopping:write` | Cancel an order owned by the authenticated user |

Protected calls use a Bearer token. For MCP clients, provide it as `_meta.authorization: "Bearer <token>"`; for Streamable HTTP clients, send the normal `Authorization` header. The verified JWT `sub` is the user ID—no tool accepts a caller-supplied `userId`. Tokens must contain a non-empty `sub`, `iss`, `aud`, and unexpired `exp` claim.

### Authentication configuration

The selected strategy is a Better Auth JWT bridge for a trusted first-party frontend. The supported clients are that frontend and MCP clients that can forward bearer credentials. Better Auth must issue a signed JWT with a stable application-user `sub` claim. The recommended Better Auth JWT plugin configuration uses its JWKS endpoint and EdDSA; this server also supports explicitly configured RS*, PS*, ES*, and HS* algorithms. The server expects the following token contract from `.env.example`:

- `JWT_ALGORITHM=EdDSA` and `JWT_JWKS_URI=https://<frontend>/api/auth/jwks` (recommended)
- Or `JWT_ALGORITHM=HS256` and `JWT_SECRET` when the issuer is explicitly configured to mint HMAC tokens
- `JWT_AUDIENCE=amazon-mcp`
- `JWT_ISSUER=better-auth`
- `JWT_EXPIRES_IN=1h` (the issuer controls the actual `exp` claim)

The guard verifies the signature against the configured HMAC secret or cached remote JWKS, requires an explicit algorithm allowlist, validates expiration, issuer, audience, and non-empty `sub`, and fails closed when JWKS cannot validate a token. It accepts `Authorization: Bearer <token>` from HTTP requests and the equivalent MCP `_meta.authorization` metadata. Protected reads require `shopping:read`; cart, checkout, placement, and cancellation writes require `shopping:write`. A token with both scopes is needed for the complete recommended flow.

The corresponding Better Auth configuration should make these values explicit (the scopes should come from the application's authorization policy):

```ts
jwt({
  jwks: {
    keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' },
    rotationInterval: 60 * 60 * 24 * 30,
    gracePeriod: 60 * 60 * 24 * 30,
  },
  jwt: {
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
    expirationTime: process.env.JWT_EXPIRES_IN,
    getSubject: (session) => session.user.id,
    definePayload: ({ user }) => ({
      sub: user.id,
      scopes: ['shopping:read', 'shopping:write'],
    }),
  },
})
```

### Key rotation

For HMAC mode, JWT verification supports a current secret and one temporary previous secret. To rotate without logging out active users:

1. Generate a new random secret and deploy it as `JWT_SECRET`.
2. Move the old value to `JWT_SECRET_PREVIOUS` in the same deployment.
3. Keep the previous value for at least the maximum token lifetime (and any clock-skew/rollout buffer).
4. Remove `JWT_SECRET_PREVIOUS` in a later deployment after that window.

For the recommended JWKS mode, configure Better Auth's `rotationInterval` and `gracePeriod`; the server caches the JWKS, refreshes on key IDs, and never falls back to an old or unsigned key when verification fails. Never log secrets or tokens. A token signed by any other key/secret, with the wrong issuer/audience, malformed claims, wrong signature, or expired `exp` is rejected.

OAuth discovery is intentionally not enabled by default because this deployment targets a trusted first-party frontend. If external OAuth authorization-server clients are required, configure NitroStack's OAuth module and discovery endpoints before exposing the HTTP transport to them.

Recommended flow:

```text
search_products → get_product → add_to_cart → view_cart
→ checkout → confirm quote → place_order → get_order
```

### Resources and prompt

- `shopping://catalog-guide`
- `shopping://featured-products`
- `shopping://categories`
- `shopping://cart-guide`
- `shopping://order-guide`
- `shopping://order-statuses`
- `metrics://shopping`
- `health://checks`
- `widget://examples`
- `shopping_assistant` prompt for guided product research

Widget resources are automatically registered for every tool decorated with `@Widget`. `pnpm build` runs the Next.js static export and places the seven bundles in `src/widgets/out/`.

## Commands

```bash
pnpm dev            # development stdio server
pnpm build          # widget export + TypeScript build
pnpm test           # build + unit tests + MCP protocol tests
pnpm test:unit      # unit and persistence tests only
pnpm test:coverage  # unit tests with coverage thresholds
pnpm test:postgres  # persistence tests against TEST_DATABASE_URL
pnpm verify         # build + lint + typecheck + unit tests + protocol tests
pnpm verify:mcp     # stdio, HTTP, dual, JWKS, and widget-mode protocol tests
pnpm verify:live    # live eBay checks; skips without EBAY_APP_ID/EBAY_CERT_ID
pnpm lint           # repository lint and formatting checks
pnpm typecheck      # TypeScript only
pnpm start          # build, then start
pnpm start:prod     # start an existing dist build
```

Postgres coverage is opt-in and truncates every shopping table, so point it only at a disposable database:

```bash
TEST_DATABASE_URL=postgresql://user@localhost:5432/amazon_mcp_test pnpm test:postgres
```

## Correctness guarantees

- **Cart contents come from the server.** `add_to_cart` accepts only `item_id` and `quantity`; the title, price, currency, URL, and availability are fetched from eBay. A forged price or a nonexistent item cannot enter a cart.
- **Cart writes are atomic.** Every mutation is a locked read-modify-write (a per-user advisory lock plus row lock on Postgres, a serialized write queue for the file adapter), so concurrent `add_to_cart` calls cannot lose an update.
- **Quotes are durable and cart-bound.** A checkout quote is persisted and fingerprinted against the cart it was priced from. If the cart changes afterwards, `place_order` returns a conflict and the newer cart is left intact.
- **Placement re-validates and is idempotent.** Prices and availability are re-read immediately before placement, and the `checkout_id` acts as the idempotency key: a retry returns the original order (`alreadyPlaced: true`), and two replicas cannot both consume one quote.
- **The eBay budget is shared.** With `DATABASE_URL` the daily application quota is an atomic Postgres counter that survives restarts and is shared by every replica. It counts eBay requests, not tool calls, because `@Cache` wraps `@RateLimit`.
- **Failures stay quiet.** Upstream messages are redacted before they reach tool output, logs, or metrics, and unexpected errors are replaced with a generic message.

## Observability

`metrics://shopping` reports tool invocations, failures and error codes, eBay request counts, latency, retries and failure categories, catalog cache hit rate, quota usage, storage mode, applied migrations, and evaluated alerts (sustained eBay failures, a low or exhausted daily budget, an unreachable quota counter). It contains names, counts, and durations only — never tokens, credentials, or shopper data.

Over HTTP, `/healthz` is liveness (process only, so a dependency outage never triggers a restart) and `/readyz` is readiness (fails when persistence is unusable; a degraded eBay dependency is reported but does not remove the replica from service). `health://checks` remains the MCP-facing view.

## Persistence and deployment

The Postgres adapter applies versioned, forward-only migrations at startup (`shopping_schema_migrations`), each inside a transaction under an advisory lock so concurrent replicas cannot apply the same version twice. It creates `shopping_carts`, `shopping_orders`, `shopping_quotes`, and `ebay_quota`, and scopes every read by the authenticated user.

**Postgres is required for more than one replica.** Carts, checkout quotes, orders, and the eBay quota counter all live there. The JSON adapter keeps its state in one process and is for a single local/demo instance only.

Before deployment:

1. Set `NODE_ENV=production` and explicitly choose `MCP_TRANSPORT_TYPE=http` (or `dual` only when stdio is intentionally needed).
2. Set `HOST=0.0.0.0`, `DATABASE_URL`, TLS settings, `JWT_SECRET`, and live eBay credentials through the secret manager.
3. Set `SHOPPING_FULFILLMENT_MODE=demo` explicitly; startup fails without it outside development.
4. Keep `EBAY_MOCK=false` for live access and verify `health://checks` reports the database and eBay as `up`.
5. Run `pnpm verify`, and `pnpm verify:live` once against the eBay sandbox with real credentials.
6. Put the HTTP transport behind TLS. Set `TRUSTED_FORWARDED_HOSTS` to the public host and `REQUIRE_HTTPS=true` when a proxy terminates TLS. Leave CORS disabled for non-browser clients, or set `ENABLE_CORS=true` with an exact `CORS_ALLOWED_ORIGINS` allowlist; wildcard CORS is not supported.
7. Load `JWT_*`, `DATABASE_URL`, and eBay credentials from the platform's secret store. Never commit a `.env`.

### Logging and retention

Log records carry a request ID, tool name, authenticated subject, duration, and error code. Tool input is never logged, because it can contain a shipping address and `_meta.authorization` carries a bearer token; upstream eBay messages are redacted before they are logged. Treat the subject claim as personal data and keep operational logs to the shortest retention your incident process allows.

### Not a real commerce backend

`place_order` records an order in this server's database. There is no payment authorization or capture, no inventory reservation, no eBay order or fulfilment integration, and no refund handling — the eBay Browse and Taxonomy APIs are read-only under an application token and cannot reserve stock. Orders therefore have exactly two states, `placed` and `cancelled`, any un-cancelled order is eligible for cancellation, and every order reports `fulfillment: "demo"`. `SHOPPING_FULFILLMENT_MODE=external` is rejected at startup so a deployment cannot appear to be something it is not.
