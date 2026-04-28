const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const logger = require('../utils/logger');
const productSync = require('../sync/products');
const inventorySync = require('../sync/inventory');
const shopifyOrders = require('../sync/shopify-orders');

// HMAC verification middleware for Shopify webhooks
function verifyShopifyWebhook(req, res, next) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac) {
    logger.warn('Webhook missing HMAC header');
    return res.status(401).send('Missing HMAC');
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('SHOPIFY_WEBHOOK_SECRET not configured');
    return res.status(500).send('Webhook secret not configured');
  }

  const hash = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || '', 'utf8')
    .digest('base64');

  if (hash !== hmac) {
    logger.warn('Webhook HMAC verification failed');
    return res.status(401).send('Invalid HMAC');
  }

  next();
}

// Product update webhook
router.post('/products-update', verifyShopifyWebhook, async (req, res) => {
  res.status(200).send('OK'); // Respond immediately

  const product = req.body;
  logger.info(`Webhook: product updated ${product.id} - ${product.title}`);

  try {
    await productSync.syncSingleProduct(product);
  } catch (err) {
    logger.error(`Webhook product sync error: ${err.message}`);
  }
});

// Product delete webhook
router.post('/products-delete', verifyShopifyWebhook, async (req, res) => {
  res.status(200).send('OK');

  const { id } = req.body;
  logger.info(`Webhook: product deleted ${id}`);

  // Mark all variants as deleted in product_map
  const db = require('../../db');
  db.prepare(
    "UPDATE product_map SET status = 'deleted', last_synced_at = datetime('now') WHERE shopify_product_id = ?"
  ).run(String(id));
});

// Inventory level update webhook
router.post('/inventory_levels-update', verifyShopifyWebhook, async (req, res) => {
  res.status(200).send('OK');

  const { inventory_item_id, available } = req.body;
  logger.info(`Webhook: inventory updated for item ${inventory_item_id}, available: ${available}`);

  try {
    await inventorySync.syncSingleItem(inventory_item_id, available);
  } catch (err) {
    logger.error(`Webhook inventory sync error: ${err.message}`);
  }
});

// Order paid → decrement Allegro stock for mapped line items
router.post('/orders-paid', verifyShopifyWebhook, async (req, res) => {
  res.status(200).send('OK');
  const order = req.body;
  logger.info(`Webhook: order paid ${order?.id} (${order?.line_items?.length || 0} items)`);

  try {
    await shopifyOrders.handleOrderPaid(order);
  } catch (err) {
    logger.error(`Webhook orders/paid error: ${err.message}`);
  }
});

// Order cancelled → restore Allegro stock for previously decremented items
router.post('/orders-cancelled', verifyShopifyWebhook, async (req, res) => {
  res.status(200).send('OK');
  const order = req.body;
  logger.info(`Webhook: order cancelled ${order?.id}`);

  try {
    await shopifyOrders.handleOrderCancelled(order);
  } catch (err) {
    logger.error(`Webhook orders/cancelled error: ${err.message}`);
  }
});

// Refund created → restore Allegro stock for refunded quantities
router.post('/refunds-create', verifyShopifyWebhook, async (req, res) => {
  res.status(200).send('OK');
  const refund = req.body;
  logger.info(`Webhook: refund created order=${refund?.order_id}`);

  try {
    await shopifyOrders.handleRefundCreated(refund);
  } catch (err) {
    logger.error(`Webhook refunds/create error: ${err.message}`);
  }
});

module.exports = router;
