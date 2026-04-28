const db = require('../../db');
const shopify = require('../api/shopify');
const allegro = require('../api/allegro');
const logger = require('../utils/logger');

function logSync(direction, entityId, status, message) {
  db.prepare(
    'INSERT INTO sync_log (sync_type, direction, entity_id, status, message) VALUES (?, ?, ?, ?, ?)'
  ).run('orders', direction, entityId, status, message);
}

const insertSyncRow = db.prepare(`
  INSERT INTO shopify_order_sync
    (shopify_order_id, event_type, shopify_variant_id, allegro_offer_id, sku,
     quantity_change, allegro_stock_before, allegro_stock_after, status, message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(shopify_order_id, event_type, shopify_variant_id) DO NOTHING
`);

const findExistingPaid = db.prepare(`
  SELECT id, allegro_offer_id, sku, quantity_change
  FROM shopify_order_sync
  WHERE shopify_order_id = ? AND event_type = 'paid' AND shopify_variant_id = ?
    AND status = 'success'
`);

const wasImportedFromAllegro = db.prepare(
  'SELECT 1 FROM order_map WHERE shopify_order_id = ?'
);

function findMapping(variantId) {
  if (!variantId) return null;
  return db
    .prepare("SELECT * FROM product_map WHERE shopify_variant_id = ? AND status = 'active'")
    .get(String(variantId));
}

async function applyDelta({
  orderId,
  eventType,
  variantId,
  sku,
  quantityChange,
}) {
  const orderIdStr = String(orderId);
  const variantIdStr = variantId ? String(variantId) : null;

  // Idempotency: this exact (order, event, variant) tuple already processed?
  const existing = db
    .prepare(
      'SELECT id, status FROM shopify_order_sync WHERE shopify_order_id = ? AND event_type = ? AND shopify_variant_id = ?'
    )
    .get(orderIdStr, eventType, variantIdStr);
  if (existing) {
    logger.debug(
      `shopify→allegro: ${eventType} ${orderIdStr}/${variantIdStr} already processed (${existing.status}), skipping`
    );
    return { status: 'skipped_duplicate' };
  }

  // Skip orders that we imported from Allegro (Allegro side already accounted for stock)
  if (eventType === 'paid' && wasImportedFromAllegro.get(orderIdStr)) {
    insertSyncRow.run(
      orderIdStr,
      eventType,
      variantIdStr,
      null,
      sku || null,
      0,
      null,
      null,
      'skipped_imported',
      'Order originated from Allegro import; skipping reverse sync'
    );
    logger.info(
      `shopify→allegro: order ${orderIdStr} is an Allegro import, skipping`
    );
    return { status: 'skipped_imported' };
  }

  const mapping = findMapping(variantIdStr);
  if (!mapping || !mapping.allegro_offer_id) {
    insertSyncRow.run(
      orderIdStr,
      eventType,
      variantIdStr,
      null,
      sku || null,
      0,
      null,
      null,
      'skipped_unmapped',
      'No active product_map entry for this variant'
    );
    logger.warn(
      `shopify→allegro: variant ${variantIdStr} (sku=${sku || '?'}) has no Allegro mapping, skipping`
    );
    return { status: 'skipped_unmapped' };
  }

  const offerId = mapping.allegro_offer_id;

  try {
    const offer = await allegro.getOfferStatus(offerId);
    const currentStock = offer.stock?.available ?? 0;
    const newStock = Math.max(0, currentStock + quantityChange);

    if (newStock === currentStock) {
      insertSyncRow.run(
        orderIdStr,
        eventType,
        variantIdStr,
        offerId,
        sku || null,
        quantityChange,
        currentStock,
        newStock,
        'success',
        'No change needed (already at floor or zero delta)'
      );
      return { status: 'success', currentStock, newStock };
    }

    await allegro.updateOfferStock(offerId, newStock);

    insertSyncRow.run(
      orderIdStr,
      eventType,
      variantIdStr,
      offerId,
      sku || null,
      quantityChange,
      currentStock,
      newStock,
      'success',
      `Stock ${currentStock} → ${newStock} (Δ ${quantityChange})`
    );

    logSync(
      'shopify_to_allegro',
      offerId,
      'success',
      `Order ${orderIdStr} ${eventType}: stock ${currentStock} → ${newStock}`
    );
    logger.info(
      `shopify→allegro: order ${orderIdStr} ${eventType} → offer ${offerId} stock ${currentStock} → ${newStock}`
    );

    return { status: 'success', currentStock, newStock };
  } catch (err) {
    insertSyncRow.run(
      orderIdStr,
      eventType,
      variantIdStr,
      offerId,
      sku || null,
      quantityChange,
      null,
      null,
      'error',
      err.message?.slice(0, 500) || 'Unknown error'
    );
    logSync('shopify_to_allegro', offerId, 'error', err.message);
    logger.error(
      `shopify→allegro: error processing order ${orderIdStr} (${eventType}, offer ${offerId}): ${err.message}`
    );
    return { status: 'error', error: err.message };
  }
}

async function handleOrderPaid(payload) {
  const orderId = payload?.id;
  if (!orderId) {
    logger.warn('shopify→allegro: orders/paid webhook missing id, ignoring');
    return;
  }

  const lineItems = payload.line_items || [];
  logger.info(
    `shopify→allegro: orders/paid order=${orderId} line_items=${lineItems.length}`
  );

  for (const item of lineItems) {
    const qty = Number(item.quantity || 0);
    if (qty <= 0) continue;
    await applyDelta({
      orderId,
      eventType: 'paid',
      variantId: item.variant_id,
      sku: item.sku,
      quantityChange: -qty,
    });
  }
}

async function handleOrderCancelled(payload) {
  const orderId = payload?.id;
  if (!orderId) {
    logger.warn('shopify→allegro: orders/cancelled webhook missing id, ignoring');
    return;
  }

  const orderIdStr = String(orderId);
  const lineItems = payload.line_items || [];
  logger.info(
    `shopify→allegro: orders/cancelled order=${orderIdStr} line_items=${lineItems.length}`
  );

  for (const item of lineItems) {
    const variantIdStr = item.variant_id ? String(item.variant_id) : null;

    // Only restore if we previously decremented (success on 'paid' for this variant)
    const paid = variantIdStr ? findExistingPaid.get(orderIdStr, variantIdStr) : null;
    if (!paid) {
      insertSyncRow.run(
        orderIdStr,
        'cancelled',
        variantIdStr,
        null,
        item.sku || null,
        0,
        null,
        null,
        'skipped_duplicate',
        'No prior successful paid decrement to revert'
      );
      continue;
    }

    const qty = Number(item.quantity || 0);
    if (qty <= 0) continue;

    await applyDelta({
      orderId: orderIdStr,
      eventType: 'cancelled',
      variantId: variantIdStr,
      sku: item.sku,
      quantityChange: +qty,
    });
  }
}

async function handleRefundCreated(payload) {
  // refund payload shape: { order_id, refund_line_items: [{ line_item_id, quantity, line_item: {...} }] }
  const orderId = payload?.order_id;
  if (!orderId) {
    logger.warn('shopify→allegro: refunds/create webhook missing order_id, ignoring');
    return;
  }

  const orderIdStr = String(orderId);
  const refundLineItems = payload.refund_line_items || [];
  logger.info(
    `shopify→allegro: refunds/create order=${orderIdStr} items=${refundLineItems.length}`
  );

  // refund_line_items[].line_item may not include variant_id depending on API version → fall back to fetching the order
  let cachedOrder = null;
  async function lookupVariant(lineItemId) {
    if (!cachedOrder) {
      try {
        cachedOrder = await shopify.getOrder(orderIdStr);
      } catch (err) {
        logger.error(`shopify→allegro: failed to fetch order ${orderIdStr} for refund lookup: ${err.message}`);
        cachedOrder = { line_items: [] };
      }
    }
    return (cachedOrder.line_items || []).find(li => String(li.id) === String(lineItemId));
  }

  for (const rli of refundLineItems) {
    const qty = Number(rli.quantity || 0);
    if (qty <= 0) continue;

    let variantId = rli.line_item?.variant_id;
    let sku = rli.line_item?.sku;

    if (!variantId) {
      const original = await lookupVariant(rli.line_item_id);
      variantId = original?.variant_id;
      sku = sku || original?.sku;
    }

    if (!variantId) {
      const variantIdStr = null;
      insertSyncRow.run(
        orderIdStr,
        'refunded',
        variantIdStr,
        null,
        sku || null,
        0,
        null,
        null,
        'skipped_unmapped',
        `Could not resolve variant for refund line_item ${rli.line_item_id}`
      );
      continue;
    }

    await applyDelta({
      orderId: orderIdStr,
      eventType: 'refunded',
      variantId,
      sku,
      quantityChange: +qty,
    });
  }
}

module.exports = {
  handleOrderPaid,
  handleOrderCancelled,
  handleRefundCreated,
};
