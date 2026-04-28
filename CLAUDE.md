# GuruLINKER — Shopify ↔ Allegro Bridge

## Overview
Node.js/Express app that syncs products, inventory, and orders between Shopify and Allegro (Polish e-commerce platform). Uses SQLite (better-sqlite3), EJS templates, and cron scheduling.

## Tech Stack
- **Runtime:** Node.js, Express
- **Database:** SQLite (better-sqlite3) at `data/bridge.db`, WAL mode
- **Views:** EJS templates (Russian UI)
- **Scheduling:** node-cron (every minute for sync tasks)
- **Process Manager:** PM2 (ecosystem.config.js)
- **APIs:** Shopify Admin REST API, Allegro REST API

## Project Structure
```
index.js              # Express server + cron jobs (port from .env)
db/index.js           # SQLite setup + schema init
db/schema.sql         # All table definitions
src/api/shopify.js    # Shopify API client with rate limiting
src/api/allegro.js    # Allegro API client with OAuth + rate limiting
src/sync/products.js  # SKU-based product matching (no creation)
src/sync/inventory.js # Bidirectional inventory sync (Last-Write-Wins)
src/sync/orders.js    # Allegro → Shopify order import
src/sync/prices.js    # Shopify → Allegro price sync (currently disabled)
src/routes/auth.js    # OAuth flows for both platforms
src/routes/dashboard.js # Dashboard routes + logs API
src/routes/webhooks.js  # Shopify webhook handlers
src/utils/logger.js   # Winston logger + in-memory ring buffer
src/utils/queue.js    # Rate-limited task queue
views/*.ejs           # Dashboard pages (Russian)
public/               # Static CSS + JS
ecosystem.config.js   # PM2 config
deploy/               # nginx config template
```

## Key Architecture Decisions
- **SKU matching only** — Products matched by `external.id` field on Allegro, NOT created
- **Single PM2 instance** — SQLite doesn't support concurrent writers
- **Last-Write-Wins** — Inventory sync uses timestamps to avoid conflicts
- **Ring buffer logger** — Last 500 log entries in memory for `/dashboard/logs` page
- **All cron tasks run every minute** with `isRunning` flags to prevent overlap

## Database Tables
- `product_map` — Shopify variant ↔ Allegro offer mapping
- `order_map` — Allegro order → Shopify order mapping
- `sync_log` — Audit trail for all sync operations
- `allegro_tokens` / `shopify_tokens` — OAuth token storage
- `unmatched_skus` — SKUs that couldn't be matched

## Commands
```bash
npm start              # Production start
npm run dev            # Development with nodemon
pm2 start ecosystem.config.js --env production  # PM2 production
npm run test-connection  # Test API connectivity
npm run register-webhooks  # Register Shopify webhooks
```

## Environment
All config in `.env` — see `.env.example` for reference.
Key vars: `SHOPIFY_STORE`, `ALLEGRO_CLIENT_ID`, `APP_URL`, `PORT`

## Deployment
- PM2 for process management
- Nginx as reverse proxy (see `deploy/nginx.conf.example`)
- SSL via Let's Encrypt
- Update `APP_URL` and `ALLEGRO_REDIRECT_URI` for production domain

## Important Notes
- Rate limiting: Shopify 40 req/bucket with leaky bucket, Allegro 3 concurrent
- Allegro OAuth tokens auto-refresh 5 min before expiry + cron every 11h
- Price sync is disabled (user only needs inventory/order sync)
- Console transport always on (for PM2 log capture)
