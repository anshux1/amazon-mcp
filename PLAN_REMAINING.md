# Remaining Build Plan

This file contains only the unfinished work identified during the codebase review. The original full plan remains in [`PLAN.md`](./PLAN.md).

The current repository is a working MVP/demo. The items below are the remaining work required for a reliable production deployment.

---

## Phase 2 — Authentication Decisions and Integration

### 2.1 Operationalize the selected authentication strategy

The primary strategy is now the Better Auth JWT bridge for the trusted first-party frontend. Finish the operational work:

- Confirm the supported clients, token location, issuer, audience, algorithm, and expiration policy in the deployed Better Auth configuration.
- Define and test a key-rotation process so changing `JWT_SECRET` does not unexpectedly invalidate all production users.

### 2.2 Complete and verify the Better Auth JWT bridge

- Configure the Better Auth JWT plugin in the frontend/authentication system.
- Confirm that Better Auth emits a stable `sub` claim representing the application user ID.
- Confirm the configured `iss`, `aud`, `exp`, and signing algorithm match `src/modules/auth/jwt.guard.ts`.
- Test both HTTP `Authorization` headers and MCP `_meta.authorization` metadata.
- Test expired, malformed, wrong-audience, wrong-issuer, and wrong-signature tokens.

### 2.3 Add asymmetric/JWKS support if required

- If Better Auth or the selected OAuth provider uses RS256/ES256, add JWKS/public-key verification instead of assuming an HMAC shared secret.
- Validate the JWT algorithm against an explicit allowlist.
- Cache JWKS metadata safely and define behavior when the key endpoint is unavailable.
- Add key rollover tests.

### 2.4 Add OAuth 2.1 support if external clients are required

- Configure NitroStack's OAuth module/template rather than exposing JWT-protected HTTP tools without a discovery flow.
- Expose protected-resource and authorization-server metadata endpoints.
- Configure authorization server URL, resource URI, supported scopes, and token audience.
- Verify the complete authorization-code/PKCE flow with an actual MCP client.
- Ensure the OAuth access token reaches the existing guard and resolves the correct `ctx.auth.subject`.

### 2.5 Enforce scopes or roles

- Decide whether `shopping:read` and `shopping:write` are required.
- Enforce read permission for protected reads such as `view_cart`, `get_order`, and `order_history`.
- Enforce write permission for `add_to_cart`, `update_cart_item`, `checkout`, `place_order`, and `cancel_order`.
- Add a separate role guard if administrative operations are added later.
- Add tests proving a valid JWT with insufficient scopes is rejected.

---

## Phase 3 — Live eBay Integration Validation

### 3.1 Test the live Browse API integration

- Run `search_products` using real eBay credentials in a non-production environment.
- Verify query, category, pagination, sorting, marketplace, currency, price, condition, seller, image, shipping, and availability mappings.
- Test `get_product` with a real item ID and with a missing/invalid item ID.
- Confirm that the configured sandbox/production setting is honored.

### 3.2 Test the live Taxonomy API integration

- Test the default category tree with `get_categories({ category_id: "0" })`.
- Test a valid category subtree.
- Test an invalid category ID and verify it becomes the expected `NOT_FOUND` response.
- Verify that large category trees do not exceed practical response/widget limits.

### 3.3 Validate eBay failure behavior

- Test invalid credentials, expired application tokens, timeouts, network failures, HTTP 404s, and eBay quota errors.
- Confirm that secrets and raw authorization data never appear in tool output or logs.
- Define whether retries/backoff are needed for transient eBay failures.
- Confirm `health://checks` reports the correct eBay status in configured, degraded, and unavailable states.

---

## Phase 4 — Cart, Checkout, and Order Correctness

### 4.1 Stop trusting caller-supplied product snapshots

- Decide whether `add_to_cart` should accept only `item_id` and `quantity`.
- Prefer fetching the product through `ProductsService` when adding an item so title, price, currency, URL, and availability originate from the server.
- If snapshots remain accepted for latency reasons, clearly mark them as display-only and never use them as authoritative data.
- Reject nonexistent or invalid eBay item IDs before saving them to a cart.
- Add tests for forged prices, currencies, titles, and unavailable items.

### 4.2 Make checkout quotes durable for deployment topology

- Persist `CheckoutQuote` records if the server can restart or run more than one replica.
- Store quote ownership, expiration, quoted item data, totals, shipping address, and a cart revision/hash.
- Add cleanup for expired quotes.
- If quotes remain in memory, explicitly enforce/document single-process deployment and reject configurations that require replicas.

### 4.3 Prevent stale quotes from destroying newer cart changes

- Bind a quote to the cart state used to create it.
- At `place_order`, verify that the cart has not changed since checkout.
- Do not clear a newly modified cart when placing an older quote.
- Decide whether only one active quote per user is allowed or whether multiple quotes can coexist safely.
- Add tests for cart changes between `checkout` and `place_order`.

### 4.4 Revalidate price and availability at order placement

- Decide whether the eBay item price and availability must be fetched again immediately before placement.
- If price/availability changed, return a clear conflict requiring a new checkout quote.
- If real inventory reservation is required, add a reservation mechanism; the current read-only eBay application-token flow cannot reserve inventory.
- Add tests for price changes, quantity changes, and stock changes during the quote lifetime.

### 4.5 Make cart updates concurrency-safe

- Replace the current read-modify-write pattern with an atomic database transaction, row lock, or optimistic revision check for Postgres.
- Ensure concurrent `add_to_cart` and `update_cart_item` requests do not lose updates.
- Define equivalent guarantees for the JSON-file adapter.
- Add concurrent-operation tests.

### 4.6 Make order placement idempotent

- Define how a client safely retries `place_order` after a timeout.
- Add an idempotency key or durable placement state if duplicate orders must be prevented across processes.
- Ensure two replicas cannot place the same quote concurrently.

### 4.7 Add real commerce integrations if required

The current `place_order` only stores an internal order. If this is intended to become a real shopping checkout, add:

- Payment authorization and capture.
- Inventory reservation.
- eBay order/fulfillment integration or another fulfillment provider.
- Refund handling for cancellation.
- Order states beyond `placed` and `cancelled`.
- Cancellation eligibility rules and a fulfillment-aware cancellation workflow.

If real commerce is out of scope, keep the limitation clearly documented and enforce demo-safe production configuration.

### 4.8 Correct the featured-products resource

- Replace the live-mode `query: 'demo'` behavior in `shopping://featured-products` with a deterministic featured-product strategy.
- Ensure the resource returns useful data in both demo and live modes.
- Add a resource test for both modes.

---

## Phase 5 — Cross-Cutting Safety and Observability

### 5.1 Add dependency and quota observability

- Record eBay request counts, cache hits/misses, rate-limit rejections, latency, and failure categories.
- Add alerts for sustained eBay failures and quota exhaustion.
- Ensure logs contain request IDs and tool names but do not contain tokens, secrets, or full addresses unnecessarily.
- Define a log retention and redaction policy for production.

### 5.2 Validate all response/error paths

- Add tests for every typed error: unauthorized, bad request, not found, conflict, out of stock, database unavailable, external-service failure, and rate-limited responses.
- Confirm all tool errors retain the standard response shape across stdio, HTTP, and dual transports.
- Add output schemas where stable client-side contracts are required.

---

## Phase 6 — Widget and Client Validation

### 6.1 Test widgets in NitroStudio

- Open every widget in NitroStudio.
- Invoke each linked tool and verify the widget receives the expected structured output.
- Verify loading, empty, success, and error states.
- Verify dark mode, narrow widths, long product titles, large category trees, and large order histories.

### 6.2 Test both widget protocol modes

- Verify `NITROSTACK_APP_MODE=mcp-app` behavior.
- Verify `NITROSTACK_APP_MODE=openai` behavior.
- Verify universal mode does not produce incorrect resource MIME types or output-template metadata.
- Read each generated widget resource through MCP, not only through the static file system.

### 6.3 Configure widget CSP and external assets

- Add appropriate widget CSP/resource-domain metadata for eBay image hosts and any other external resources.
- Test images inside the target MCP client sandbox.
- Ensure dynamic eBay image URLs remain allowed without opening an unnecessarily broad policy.

### 6.4 Decide whether widgets need interactive actions

If widgets should support more than display-only rendering:

- Add `callTool` actions for cart and order operations.
- Add confirmation UI before mutating tools are called.
- Add follow-up chat actions where useful.
- Preserve and test widget state synchronization.

---

## Phase 7 — Distributed eBay Quota Protection

### 7.1 Make quota state distributed when replicas are used

- Replace the current single-process quota storage for multi-instance production.
- Use a shared Redis, Postgres, or equivalent atomic counter.
- Define behavior when the shared limiter is unavailable.
- Prevent process restarts from resetting the daily application budget.

### 7.2 Monitor and test quota behavior

- Expose safe metrics for remaining budget and rejected calls.
- Add alerting before the hard eBay limit is reached.
- Add a test proving `search_products`, `get_product`, and `get_categories` reject requests after the shared budget is exhausted.
- Test concurrent requests across all three tools and multiple server instances.
- Test the daily-window reset behavior.
- Document whether cached calls count as tool invocations or only actual eBay requests.

---

## Phase 8 — Automated Testing and Development Workflow

### 8.1 Add unit tests

Cover at minimum:

- Money rounding and currency handling.
- Input normalization and Zod validation.
- eBay response normalization.
- Cart totals and quantity limits.
- Quote totals, tax, shipping, expiration, and status transitions.
- JWT extraction and validation.
- Exception-filter mappings.
- Cache-key construction and metadata stripping.

### 8.2 Add integration tests for persistence

- Test the memory adapter.
- Test the JSON-file adapter across process startup/reload.
- Test Postgres table creation, reads, writes, user isolation, transactions, and failure behavior.
- Test concurrent cart and order operations.

### 8.3 Expand MCP protocol tests

- Keep the existing stdio smoke test.
- Add automated HTTP Streamable MCP tests.
- Add automated dual-transport tests.
- Test session creation, session headers, authorization headers, legacy SSE, malformed requests, and session cleanup.
- Test resources, prompts, widget resources, structured content, and metadata.

### 8.4 Add negative business-flow tests

- Empty checkout.
- Invalid product and category IDs.
- Out-of-stock quantity.
- Mixed currencies.
- Expired checkout quote.
- Wrong-user quote/order access.
- Already-cancelled order.
- Cart changes after checkout.
- Duplicate/concurrent order placement.
- Database and eBay outages.

### 8.5 Add live and client-gated test jobs

- Add a credential-gated live eBay integration job.
- Add a Postgres integration job using a disposable database.
- Add widget build/render checks.
- Add a NitroStudio/manual-client validation checklist if full automation is unavailable.

### 8.6 Make `pnpm test` a real test command

- Add a test runner and test files instead of aliasing `pnpm test` only to `pnpm verify`.
- Keep `pnpm verify` as the end-to-end smoke test.
- Add coverage thresholds for core services and tools.
- Add linting and formatting checks.

### 8.7 Add CI

- Run install, typecheck, unit tests, build, widget export, and smoke tests on every change.
- Run security/dependency checks.
- Build the Docker image in CI.
- Keep live eBay and Postgres tests behind protected credentials or service containers.

---

## Phase 9 — Production Deployment

### 9.1 Validate the Docker image

- Run a clean Docker build from an empty build context/cache.
- Start the image with production environment variables.
- Verify server startup, HTTP transport, `/mcp`, `/mcp/health`, MCP resources, widget resources, and graceful shutdown.
- Verify the image works without source files or development dependencies.

### 9.2 Add production health endpoints

- Keep `health://checks` for MCP clients.
- Add or configure an HTTP readiness endpoint that reports database and eBay dependency status for load balancers/Kubernetes.
- Separate liveness from readiness so a temporary eBay outage does not necessarily restart the process.
- Add a container `HEALTHCHECK` or deployment-equivalent probe.

### 9.3 Prepare database operations

- Decide whether startup DDL is sufficient or introduce versioned migrations.
- Add migration execution to deployment/CI.
- Document rollback and schema compatibility procedures.
- Configure Postgres TLS, pool limits, connection timeouts, and replica behavior.

### 9.4 Secure the HTTP deployment

- Put HTTP transport behind TLS or a trusted reverse proxy.
- Configure a narrow CORS allowlist.
- Validate forwarded-host and forwarded-protocol behavior.
- Protect administrative and health details appropriately.
- Confirm session limits, idle cleanup, request-size limits, and rate limits under load.

### 9.5 Configure secrets and operations

- Load JWT, Better Auth, eBay, database, and OAuth secrets from a secret manager.
- Define rotation procedures.
- Do not copy `.env` files into images or source control.
- Add centralized logs, metrics, tracing, error alerts, and eBay quota alerts.
- Document backup, restore, incident response, and shutdown procedures.

### 9.6 Test multi-instance behavior

- Run at least two server replicas against shared Postgres and shared rate-limit storage.
- Verify user cart/order isolation across replicas.
- Verify checkout quote placement across replicas.
- Verify duplicate placement prevention and cache invalidation behavior.
- Run a basic load/concurrency test before production release.

---

## Recommended execution order

1. Complete the Better Auth JWT bridge verification, key rotation, and scope decisions.
2. Fix quote/cart concurrency and order-placement semantics.
3. Add unit, persistence, HTTP, and negative-path tests.
4. Add dependency/quota observability and validate live eBay, Postgres, widgets, and external MCP clients.
5. Replace the local quota bucket with distributed storage for multi-instance deployments.
6. Harden and validate the Docker/HTTP deployment.
7. Run the production checklist and perform a multi-instance test.
