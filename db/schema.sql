CREATE TABLE IF NOT EXISTS product_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_product_id TEXT NOT NULL,
  shopify_variant_id TEXT NOT NULL,
  allegro_offer_id TEXT,
  allegro_category_id TEXT,
  content_hash TEXT,
  status TEXT DEFAULT 'pending',
  last_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(shopify_product_id, shopify_variant_id)
);

CREATE TABLE IF NOT EXISTS order_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allegro_order_id TEXT UNIQUE NOT NULL,
  shopify_order_id TEXT,
  buyer_email TEXT,
  total_amount REAL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  entity_id TEXT,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS allegro_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shopify_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  scope TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS unmatched_skus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  platform TEXT NOT NULL,
  product_title TEXT,
  offer_name TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shopify_order_sync (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,            -- 'paid' | 'cancelled' | 'refunded'
  shopify_variant_id TEXT,
  allegro_offer_id TEXT,
  sku TEXT,
  quantity_change INTEGER NOT NULL,    -- negative for paid (decrement), positive for cancel/refund (restore)
  allegro_stock_before INTEGER,
  allegro_stock_after INTEGER,
  status TEXT NOT NULL,                -- 'success' | 'skipped_unmapped' | 'skipped_imported' | 'skipped_duplicate' | 'error'
  message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(shopify_order_id, event_type, shopify_variant_id)
);

CREATE INDEX IF NOT EXISTS idx_unmatched_platform ON unmatched_skus(platform);
CREATE INDEX IF NOT EXISTS idx_sync_log_type ON sync_log(sync_type, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_log_status ON sync_log(status, created_at);
CREATE INDEX IF NOT EXISTS idx_product_map_status ON product_map(status);
CREATE INDEX IF NOT EXISTS idx_product_map_allegro ON product_map(allegro_offer_id);
CREATE INDEX IF NOT EXISTS idx_sos_order ON shopify_order_sync(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_sos_created ON shopify_order_sync(created_at DESC);
