## Shopping MCP Server on NitroStack — Full Build Plan

Good — NitroStack changes the shape of this significantly. It's a decorator-based, NestJS-style MCP framework with its own module system, guards, caching, rate limiting, and even an OAuth 2.1 template out of the box. This replaces most of the manual server/transport wiring from before. Below is the plan mapped onto NitroStack's actual primitives.

---

### Phase 0 — Project Setup

- Install the NitroStack CLI and scaffold the project using `nitrostack init`, choosing the OAuth 2.1 template if available as a starting point (saves you building auth from scratch).
- Confirm Node/TypeScript version compatibility and ESM `.js`-extension import convention — NitroStack enforces this project-wide.
- Set up `ConfigModule.forRoot()` for environment variables (eBay keys, DB URL, JWT secret).

**Resources:**

- Installation: <https://docs.nitrostack.ai/installation>
- Quick Start: <https://docs.nitrostack.ai/quick-start>
- CLI Init command: <https://docs.nitrostack.ai/cli/init>
- OAuth 2.1 Template: <https://docs.nitrostack.ai/templates/oauth>
- Starter Template: <https://docs.nitrostack.ai/templates/starter>

---

### Phase 1 — Module Architecture

Structure the app as feature modules, each with its own tools + service, wired into the root `AppModule`:

- **`ProductsModule`** — catalog tools backed by eBay (search, get product, get categories)
- **`CartModule`** — cart tools backed by your own DB
- **`OrdersModule`** — checkout + order lifecycle tools backed by your own DB
- **`AuthModule`** — guards, JWT validation, user resolution

Each module exports only what other modules need (e.g. `OrdersModule` imports `CartModule` to read cart contents at checkout).

**Resources:**

- Modules: <https://docs.nitrostack.ai/sdk/typescript/server>
- Dependency Injection: <https://docs.nitrostack.ai/sdk/typescript/dependency-injection>

---

### Phase 2 — Authentication Layer

NitroStack ships two native auth mechanisms — decide between them rather than bolting on Better Auth's MCP plugin:

**Option A — API Key Auth**: simplest, good if this MCP server is only consumed by your own trusted frontend, not third-party MCP clients.

**Option B — OAuth 2.1** (recommended for your case, since it matches the MCP spec's expected flow for external clients like Claude Desktop): NitroStack has a full OAuth 2.1 guide and template.

**Bridging with your existing Better Auth setup**: since your Next.js app already authenticates users via Better Auth, the cleanest integration is:

- Enable Better Auth's JWT plugin so it mints a signed JWT on login
- NitroStack's `JWTModule.forRoot()` + `JWTGuard` validates that same JWT (shared secret or JWKS) on every MCP tool call
- `ctx.auth.subject` inside any tool becomes your trusted `userId` — never accept `userId` as a tool input parameter

Apply `@UseGuards(JWTGuard)` to every mutating tool (cart/checkout/order tools); leave catalog tools ungated if you want anonymous browsing.

**Resources:**

- Auth Overview: <https://docs.nitrostack.ai/sdk/typescript/auth/overview>
- API Key Auth: <https://docs.nitrostack.ai/sdk/typescript/auth/api-key>
- OAuth 2.1: <https://docs.nitrostack.ai/sdk/typescript/auth/oauth>
- API Keys Guide: <https://docs.nitrostack.ai/sdk/typescript/api-keys>
- OAuth 2.1 Guide: <https://docs.nitrostack.ai/sdk/typescript/oauth-2.1>
- Better Auth JWT plugin: <https://www.better-auth.com/docs/plugins/jwt>

---

### Phase 3 — eBay Integration Service

Wrap eBay access as an `@Injectable()` service (`EbayService`), constructor-injected into `ProductsTools` — keeps tools thin, logic testable.

- `EbayService` holds the `ebay-api` client instance, initialized from `ConfigService` (App ID/Cert ID from env)
- Exposes methods: `searchItems()`, `getItem()`, `getCategoryTree()`
- Called only from within `ProductsModule`'s tools, never directly from other modules

**Resources:**

- Services & DI: <https://docs.nitrostack.ai/sdk/typescript/dependency-injection>
- `ebay-api` package: <https://github.com/hendt/ebay-api>
- eBay Browse API reference: <https://developer.ebay.com/api-docs/buy/browse/overview.html>
- eBay Taxonomy API reference: <https://developer.ebay.com/api-docs/commerce/taxonomy/overview.html>
- eBay production keyset setup: <https://developer.ebay.com>

---

### Phase 4 — The 11 Tools

| Tool | Module | Guard | Cache/RateLimit |
| --- | --- | --- | --- |
| `search_products` | Products | none | `@Cache` short TTL, `@RateLimit` per-user against eBay quota |
| `get_product` | Products | none | `@Cache` |
| `get_categories` | Products | none | `@Cache` longer TTL (categories change rarely) |
| `add_to_cart` | Cart | `JWTGuard` | — |
| `view_cart` | Cart | `JWTGuard` | — |
| `update_cart_item` | Cart | `JWTGuard` | — |
| `checkout` | Orders | `JWTGuard` | — (must hit live eBay price, no cache) |
| `place_order` | Orders | `JWTGuard` | — |
| `get_order` | Orders | `JWTGuard` | — |
| `order_history` | Orders | `JWTGuard` | `@Cache` short TTL keyed by user |
| `cancel_order` | Orders | `JWTGuard` | — |

Each tool declares a Zod `inputSchema`, and per NitroStack convention should include `examples: { request, response }` — this isn't optional decoration, it's what NitroStack uses for tool documentation and likely widget linkage.

**Resources:**

- Tools: <https://docs.nitrostack.ai/sdk/typescript/tools>
- Validation (Zod): <https://docs.nitrostack.ai/sdk/typescript/validation>
- Guards API reference: <https://docs.nitrostack.ai/api/guards>
- Caching: <https://docs.nitrostack.ai/sdk/typescript/caching>
- Rate Limiting: <https://docs.nitrostack.ai/sdk/typescript/rate-limiting>

---

### Phase 5 — Cross-Cutting Concerns

- **Middleware** — add a logging middleware across all tools for observability (tool name, duration, success/failure) — useful during SIH demo/debugging.
- **Interceptors** — consider a response-transform interceptor to standardize tool output shape (`{ success, data, timestamp }`) across all 11 tools, so your eventual frontend/widget layer has one consistent contract.
- **Error Handling** — define typed errors (`NotFoundError`, `OutOfStockError`, `UnauthorizedError`) rather than throwing generic `Error` — NitroStack's error handling docs cover the expected pattern for surfacing these cleanly to the MCP client.
- **Health Checks** — add a `DatabaseHealthCheck` and an `EbayHealthCheck` (ping token fetch) so you can verify both dependencies are live independently when debugging.

**Resources:**

- Middleware: <https://docs.nitrostack.ai/sdk/typescript/middleware>
- Interceptors: <https://docs.nitrostack.ai/sdk/typescript/interceptors>
- Pipes: <https://docs.nitrostack.ai/sdk/typescript/pipes>
- Error Handling: <https://docs.nitrostack.ai/sdk/typescript/error-handling>
- Health Checks: <https://docs.nitrostack.ai/api/decorators> (covered under Feature Decorators)

---

### Phase 6 — Widgets (Optional but Native to NitroStack)

Since NitroStack has first-class widget support (unlike a raw MCP SDK server), you can attach visual components directly to tools:

- `@Widget('product-card')` on `get_product` → renders a product card inline when an MCP-capable client calls it
- `@Widget('cart-summary')` on `view_cart` / `checkout` → renders cart state visually
- `@Widget('order-confirmation')` on `place_order`

This is a genuine differentiator for your SIH demo — a shopping MCP server that renders real UI in the client, not just JSON.

**Resources:**

- UI Widgets: <https://docs.nitrostack.ai/sdk/typescript/ui/widgets>
- Widget Manifest: <https://docs.nitrostack.ai/sdk/typescript/ui/widget-manifest>
- Widget SDK Reference: <https://docs.nitrostack.ai/sdk/typescript/ui/widget-sdk>
- Widget Examples Guide: <https://docs.nitrostack.ai/guides/widget-examples>
- Pizzaz Template (widget-heavy reference example): <https://docs.nitrostack.ai/templates/pizzaz>

---

### Phase 7 — Rate Limit Protection for eBay Quota

Use NitroStack's native `@RateLimit` decorator on the three eBay-backed tools, keyed globally (not per-user) since the 5,000/day cap is shared at the application level:

```
requests: <buffer under 5000>, window: '1d', key: () => 'ebay-global'
```

This sits at the tool layer, no external service (Upstash) needed unless you want cross-instance shared state in a multi-node deployment.

**Resources:**

- Rate Limiting: <https://docs.nitrostack.ai/sdk/typescript/rate-limiting>
- eBay call limits reference: <https://developer.ebay.com/support/api-call-limits>

---

### Phase 8 — Dev & Testing

- Use **NitroStack Studio** locally to test tool calls interactively before wiring a real MCP client — it has a built-in chat interface and testing tools panel, which is faster than testing through Claude Desktop directly.
- Verify dual transport (stdio + HTTP) works if you want both local CLI testing and remote deployment.

**Resources:**

- Studio Overview: <https://docs.nitrostack.ai/studio/overview>
- Testing Tools: <https://docs.nitrostack.ai/studio/testing>
- Chat Interface: <https://docs.nitrostack.ai/studio/chat>
- Standalone Setup: <https://docs.nitrostack.ai/studio/standalone>
- Dual Transport Guide: <https://docs.nitrostack.ai/guides/dual-transport>
- Verify Transport Guide: <https://docs.nitrostack.ai/guides/verify-transport>
- Testing (unit/integration): <https://docs.nitrostack.ai/sdk/typescript/testing>

---

### Phase 9 — Deployment

- Follow NitroStack's production checklist before shipping — likely covers env var hygiene, auth secret rotation, and transport config.
- Containerize with the provided Docker guide if deploying alongside your existing Next.js/Neon stack.

**Resources:**

- Production Checklist: <https://docs.nitrostack.ai/deployment/checklist>
- Docker: <https://docs.nitrostack.ai/deployment/docker>
- Cloud Platforms: <https://docs.nitrostack.ai/deployment/cloud>
- Best Practices: <https://docs.nitrostack.ai/sdk/typescript/best-practices>
- Performance: <https://docs.nitrostack.ai/sdk/typescript/performance>

---

### Decisions to lock before building

1. **API Key vs OAuth 2.1** for the auth layer — OAuth 2.1 is the better fit if this needs to work with external MCP clients (Claude Desktop, claude.ai); API Key is faster to ship if it's only ever called by your own app.
2. **JWT bridging** — confirm whether Better Auth's JWT plugin and NitroStack's `JWTModule` can share a signing secret/JWKS endpoint cleanly, or whether it's simpler to let NitroStack's own OAuth 2.1 template own user auth entirely for this MCP server, separate from your Next.js app's session.
3. **Widgets now or later** — worth doing for the SIH demo's visual impact, but adds a Next.js-widget build step; can be deferred to a second pass after the 11 tools work end-to-end.
