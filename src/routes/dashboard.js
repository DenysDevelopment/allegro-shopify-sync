const express = require('express');
const router = express.Router();
const db = require('../../db');
const logger = require('../utils/logger');

// Main dashboard
router.get('/', (req, res) => {
  const stats = {
    totalProducts: db.prepare('SELECT COUNT(*) as count FROM product_map').get().count,
    activeProducts: db.prepare("SELECT COUNT(*) as count FROM product_map WHERE status = 'active'").get().count,
    errorProducts: db.prepare("SELECT COUNT(*) as count FROM product_map WHERE status = 'error'").get().count,
    pendingProducts: db.prepare("SELECT COUNT(*) as count FROM product_map WHERE status = 'pending'").get().count,
    staleProducts: db.prepare("SELECT COUNT(*) as count FROM product_map WHERE status = 'stale'").get().count,
    totalOrders: db.prepare('SELECT COUNT(*) as count FROM order_map').get().count,
    recentOrders: db.prepare("SELECT COUNT(*) as count FROM order_map WHERE created_at > datetime('now', '-24 hours')").get().count,
    orderRevenue: db.prepare('SELECT COALESCE(SUM(total_amount), 0) as total FROM order_map').get().total,
    recentErrors: db.prepare("SELECT * FROM sync_log WHERE status = 'error' ORDER BY created_at DESC LIMIT 5").all(),
    lastSync: {
      products: db.prepare("SELECT created_at FROM sync_log WHERE sync_type = 'products' ORDER BY created_at DESC LIMIT 1").get(),
      prices: db.prepare("SELECT created_at FROM sync_log WHERE sync_type = 'prices' ORDER BY created_at DESC LIMIT 1").get(),
      inventory: db.prepare("SELECT created_at FROM sync_log WHERE sync_type = 'inventory' ORDER BY created_at DESC LIMIT 1").get(),
      orders: db.prepare("SELECT created_at FROM sync_log WHERE sync_type = 'orders' ORDER BY created_at DESC LIMIT 1").get(),
    },
    tokenStatus: db.prepare('SELECT expires_at FROM allegro_tokens WHERE id = 1').get(),
    shopifyConnected: !!db.prepare('SELECT access_token FROM shopify_tokens WHERE id = 1').get()?.access_token || !!process.env.SHOPIFY_ACCESS_TOKEN,
    shopifyStore: process.env.SHOPIFY_STORE || 'Not configured',
    recentShopifyToAllegro: db.prepare(
      'SELECT * FROM shopify_order_sync ORDER BY created_at DESC LIMIT 20'
    ).all(),
  };

  res.render('dashboard', {
    page: 'dashboard',
    stats,
    success: req.query.success,
    error: req.query.error,
  });
});

// Products list
router.get('/products', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const statusFilter = req.query.status || 'all';

  let query = 'SELECT * FROM product_map';
  let countQuery = 'SELECT COUNT(*) as count FROM product_map';
  const params = [];

  if (statusFilter !== 'all') {
    query += ' WHERE status = ?';
    countQuery += ' WHERE status = ?';
    params.push(statusFilter);
  }

  query += ' ORDER BY last_synced_at DESC LIMIT ? OFFSET ?';

  const total = db.prepare(countQuery).get(...params).count;
  const products = db.prepare(query).all(...params, limit, offset);

  const unmatchedShopify = db.prepare("SELECT * FROM unmatched_skus WHERE platform = 'shopify' ORDER BY sku").all();
  const unmatchedAllegro = db.prepare("SELECT * FROM unmatched_skus WHERE platform = 'allegro' ORDER BY sku").all();

  res.render('products', {
    page: 'products',
    products,
    currentPage: page,
    total,
    limit,
    totalPages: Math.ceil(total / limit),
    statusFilter,
    unmatchedShopify,
    unmatchedAllegro,
  });
});

// Orders list
router.get('/orders', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as count FROM order_map').get().count;
  const orders = db.prepare(
    'SELECT * FROM order_map ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);

  res.render('orders', {
    page: 'orders',
    orders,
    currentPage: page,
    total,
    limit,
    totalPages: Math.ceil(total / limit),
  });
});

// Sync log
router.get('/sync-log', (req, res) => {
  const typeFilter = req.query.type || 'all';
  const statusFilter = req.query.status || 'all';

  let query = 'SELECT * FROM sync_log WHERE 1=1';
  const params = [];

  if (typeFilter !== 'all') {
    query += ' AND sync_type = ?';
    params.push(typeFilter);
  }
  if (statusFilter !== 'all') {
    query += ' AND status = ?';
    params.push(statusFilter);
  }

  query += ' ORDER BY created_at DESC LIMIT 200';

  const logs = db.prepare(query).all(...params);

  res.render('sync-log', {
    page: 'sync-log',
    logs,
    typeFilter,
    statusFilter,
  });
});

// Settings
router.get('/settings', (req, res) => {
  const token = db.prepare('SELECT * FROM allegro_tokens WHERE id = 1').get();

  res.render('settings', {
    page: 'settings',
    isAllegroConnected: !!token && (token.expires_at > Date.now() / 1000),
    tokenExpiresAt: token?.expires_at ? new Date(token.expires_at * 1000).toISOString() : null,
    priceMultiplier: process.env.PRICE_MULTIPLIER || '1.0',
    priceOffset: process.env.PRICE_OFFSET || '0',
    priceRound: process.env.PRICE_ROUND !== 'false',
    shopifyStore: process.env.SHOPIFY_STORE || 'Not configured',
  });
});

// Logs page
router.get('/logs', (req, res) => {
  res.render('logs', { page: 'logs' });
});

// Logs API (polled by frontend)
router.get('/api/logs', (req, res) => {
  const { getLogBuffer } = require('../utils/logger');
  let logs = getLogBuffer();

  const level = req.query.level;
  if (level && level !== 'all') {
    logs = logs.filter(e => e.level === level);
  }

  const search = req.query.search;
  if (search) {
    const q = search.toLowerCase();
    logs = logs.filter(e => e.message.toLowerCase().includes(q));
  }

  res.json(logs);
});

// Manual sync triggers
router.post('/trigger/:syncType', async (req, res) => {
  const { syncType } = req.params;
  logger.info(`Manual trigger: ${syncType}`);

  try {
    let result;
    switch (syncType) {
      case 'products':
        result = await require('../sync/products').syncProducts();
        break;
      case 'prices':
        result = await require('../sync/prices').syncPrices();
        break;
      case 'inventory':
        result = await require('../sync/inventory').syncInventory();
        break;
      case 'orders':
        result = await require('../sync/orders').syncOrders();
        break;
      default:
        return res.status(400).json({ error: 'Unknown sync type' });
    }
    res.json({ success: true, result });
  } catch (err) {
    logger.error(`Manual trigger error (${syncType}): ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
