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
| `JWT_SECRET` | Shared Better Auth signing secret; at least 32 bytes outside development |
| `JWT_AUDIENCE` / `JWT_ISSUER` | JWT claim validation values (`amazon-mcp` / `better-auth` in the example) |
| `JWT_ALGORITHM` / `JWT_EXPIRES_IN` | HMAC algorithm (`HS256`, `HS384`, or `HS512`) and token lifetime |
| `DATABASE_URL` | Postgres/Neon connection string; required outside development and takes precedence over file storage |
| `DATABASE_FILE` | Single-process local JSON store, or `:memory:` for tests; not a production fallback |
| `EBAY_APP_ID` / `EBAY_CERT_ID` | eBay keyset for live Browse/Taxonomy calls |
| `EBAY_MARKETPLACE_ID` | eBay marketplace, default `EBAY_US` |
| `EBAY_MOCK` | Set `true` to explicitly enable the deterministic offline catalog |
| `MCP_TRANSPORT_TYPE` | `stdio`, `http`, or `dual`; omitted development defaults to `stdio`, omitted production defaults to `http` |
| `PORT` / `HOST` | HTTP listener settings; production defaults to `3000` / `0.0.0.0` when omitted |
| `ENABLE_CORS` / `CORS_ALLOWED_ORIGINS` | CORS opt-in and exact comma-separated HTTP(S) origin allowlist; wildcard origins are rejected |
| `SHOPPING_TAX_RATE` | Decimal tax rate used in checkout, for example `0.0725` |

In development, missing eBay credentials are allowed for the offline demo. Outside development, set `EBAY_MOCK=true` to explicitly allow demo mode, or set `EBAY_MOCK=false` and provide both eBay credentials. A production configuration never silently falls back to the demo catalog. Monitor `health://checks` for the configured eBay status.

## MCP surface

### Tools

| Tool | Auth | Description |
| --- | --- | --- |
| `search_products` | Public | Search the eBay catalog |
| `get_product` | Public | Read current item details |
| `get_categories` | Public | Read the marketplace category tree or subtree |
| `add_to_cart` | JWT | Add or increment a user cart item |
| `view_cart` | JWT | Read the authenticated user cart |
| `update_cart_item` | JWT | Set quantity; `0` removes the item |
| `checkout` | JWT | Create a ten-minute quote with live price/availability checks |
| `place_order` | JWT | Persist an order from an unexpired quote and clear the cart |
| `get_order` | JWT | Read one order owned by the authenticated user |
| `order_history` | JWT | List the authenticated user’s orders |
| `cancel_order` | JWT | Cancel an order owned by the authenticated user |

Protected calls use a Bearer token. For MCP clients, provide it in request metadata; for HTTP clients, send the normal `Authorization` header. The verified JWT `sub` is the user ID—no tool accepts a caller-supplied `userId`.

### Authentication configuration

The selected strategy is a Better Auth JWT bridge for a trusted first-party frontend. Better Auth must issue a signed HMAC JWT with a stable application-user `sub` claim. This server expects the following token contract from `.env.example`:

- `JWT_ALGORITHM=HS256`
- `JWT_AUDIENCE=amazon-mcp`
- `JWT_ISSUER=better-auth`
- `JWT_EXPIRES_IN=1h` (the issuer controls the actual `exp` claim)
- `JWT_SECRET` shared through a secret manager, never committed to source

The guard verifies the signature, expiration, issuer, audience, and non-empty `sub`. It accepts `Authorization: Bearer <token>` from HTTP requests and the equivalent MCP `_meta.authorization` metadata. Optional `shopping:read` and `shopping:write` scope claims are captured for the future scope-enforcement phase; the current protected tools require a valid JWT.

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
- `health://checks`
- `widget://examples`
- `shopping_assistant` prompt for guided product research

Widget resources are automatically registered for every tool decorated with `@Widget`. `pnpm build` runs the Next.js static export and places the seven bundles in `src/widgets/out/`.

## Commands

```bash
pnpm dev          # development stdio server
pnpm build        # widget export + TypeScript build
pnpm verify       # build + end-to-end MCP smoke test
pnpm start        # build, then start
pnpm start:prod   # start an existing dist build
pnpm typecheck    # TypeScript only
```

## Persistence and deployment

The Postgres adapter creates `shopping_carts` and `shopping_orders` tables on startup and scopes every read by the authenticated user. Use a managed Postgres/Neon database and connection pooling for multiple replicas. The JSON adapter is intended for a single local/demo process, not shared production storage.

Before deployment:

1. Set `NODE_ENV=production` and explicitly choose `MCP_TRANSPORT_TYPE=http` (or `dual` only when stdio is intentionally needed).
2. Set `HOST=0.0.0.0`, `DATABASE_URL`, TLS settings, `JWT_SECRET`, and live eBay credentials through the secret manager.
3. Keep `EBAY_MOCK=false` for live access and verify `health://checks` reports the database and eBay as `up`.
4. Run `pnpm verify` in CI and `pnpm build` during image creation.
5. Put the HTTP transport behind TLS/auth-aware infrastructure. Leave CORS disabled for non-browser clients, or set `ENABLE_CORS=true` together with an exact `CORS_ALLOWED_ORIGINS` allowlist; wildcard CORS is not supported.

The repository also includes a multi-stage `Dockerfile`:

```bash
docker build -t shopping-mcp .
docker run --rm --env-file .env -p 3000:3000 shopping-mcp
```

The eBay integration uses application-token authentication for read-only Browse and Taxonomy APIs. A separate payment, inventory reservation, and fulfillment integration is required for a real checkout system.
