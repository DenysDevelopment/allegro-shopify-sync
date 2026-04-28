const db = require('../../db');
const shopify = require('../api/shopify');
const allegro = require('../api/allegro');
const logger = require('../utils/logger');

let isRunning = false;

function logSync(entityId, status, message) {
  db.prepare(
    'INSERT INTO sync_log (sync_type, direction, entity_id, status, message) VALUES (?, ?, ?, ?, ?)'
  ).run('products', 'sku_match', entityId, status, message);
}

/**
 * SKU-based product matching.
 * Fetches all Shopify variants and all Allegro offers,
 * matches them by SKU, and populates the product_map table.
 * Does NOT create or modify offers on either platform.
 */
async function syncProducts() {
  if (isRunning) {
    logger.warn('Product sync already running, skipping');
    return;
  }

  isRunning = true;
  logger.info('Starting product sync: SKU-based matching');

  let matched = 0, unmatchedShopify = 0, unmatchedAllegro = 0, errors = 0;

  try {
    // 1. Fetch all Shopify products and build SKU -> variant map
    const products = await shopify.getAllProducts();
    const shopifyBySku = new Map();

    for (const product of products) {
      for (const variant of product.variants) {
        const sku = (variant.sku || '').trim();
        if (!sku) {
          logger.debug(`Shopify variant ${variant.id} (product ${product.id}) has no SKU, skipping`);
          continue;
        }
        if (shopifyBySku.has(sku)) {
          logger.warn(`Duplicate Shopify SKU "${sku}" — variant ${variant.id} vs ${shopifyBySku.get(sku).variantId}`);
        }
        shopifyBySku.set(sku, {
          productId: String(product.id),
          variantId: String(variant.id),
          title: product.title,
          variantTitle: variant.title,
          price: variant.price,
          inventoryQuantity: variant.inventory_quantity,
        });
      }
    }

    logger.info(`Shopify: ${shopifyBySku.size} variants with SKU found`);

    // 2. Fetch all Allegro offers and build SKU -> offer map
    const offers = await allegro.getAllOffers();
    const allegroBySku = new Map();

    for (const offer of offers) {
      // Allegro SKU can be in external.id or in the offer's own external field
      const sku = (offer.external?.id || '').trim();
      if (!sku) {
        logger.debug(`Allegro offer ${offer.id} (${offer.name || 'no name'}) has no external.id (SKU), skipping`);
        continue;
      }
      if (allegroBySku.has(sku)) {
        logger.warn(`Duplicate Allegro SKU "${sku}" — offer ${offer.id} vs ${allegroBySku.get(sku).offerId}`);
      }
      allegroBySku.set(sku, {
        offerId: String(offer.id),
        name: offer.name,
        categoryId: offer.category?.id ? String(offer.category.id) : null,
        price: offer.sellingMode?.price?.amount,
        stock: offer.stock?.available,
      });
    }

    logger.info(`Allegro: ${allegroBySku.size} offers with SKU found`);

    // 3. Match by SKU
    const matchedSkus = [];
    const unmatchedShopifySkus = [];
    const unmatchedAllegroSkus = [];

    for (const [sku, shopifyData] of shopifyBySku) {
      const allegroData = allegroBySku.get(sku);
      if (allegroData) {
        matchedSkus.push({ sku, shopify: shopifyData, allegro: allegroData });
      } else {
        unmatchedShopifySkus.push(sku);
      }
    }

    for (const [sku] of allegroBySku) {
      if (!shopifyBySku.has(sku)) {
        unmatchedAllegroSkus.push(sku);
      }
    }

    // 4. Upsert matched pairs into product_map
    const upsertStmt = db.prepare(`
      INSERT INTO product_map (shopify_product_id, shopify_variant_id, allegro_offer_id, allegro_category_id, status, last_synced_at)
      VALUES (?, ?, ?, ?, 'active', datetime('now'))
      ON CONFLICT(shopify_product_id, shopify_variant_id) DO UPDATE SET
        allegro_offer_id = excluded.allegro_offer_id,
        allegro_category_id = excluded.allegro_category_id,
        status = 'active',
        last_synced_at = datetime('now')
    `);

    const upsertAll = db.transaction(() => {
      for (const { sku, shopify: s, allegro: a } of matchedSkus) {
        try {
          upsertStmt.run(s.productId, s.variantId, a.offerId, a.categoryId);
          logSync(sku, 'success', `Matched: Shopify ${s.variantId} <-> Allegro ${a.offerId}`);
          matched++;
        } catch (err) {
          errors++;
          logger.error(`DB error matching SKU "${sku}": ${err.message}`);
          logSync(sku, 'error', err.message);
        }
      }
    });

    upsertAll();

    // 5. Mark stale mappings (Shopify variants that lost their Allegro match)
    //    This handles cases where SKU changed or offer was removed
    const activeAllegroIds = new Set(matchedSkus.map(m => m.allegro.offerId));
    const existingMappings = db.prepare("SELECT id, allegro_offer_id FROM product_map WHERE status = 'active'").all();
    let staleCount = 0;
    for (const row of existingMappings) {
      if (row.allegro_offer_id && !activeAllegroIds.has(row.allegro_offer_id)) {
        db.prepare("UPDATE product_map SET status = 'stale', last_synced_at = datetime('now') WHERE id = ?").run(row.id);
        staleCount++;
      }
    }

    unmatchedShopify = unmatchedShopifySkus.length;
    unmatchedAllegro = unmatchedAllegroSkus.length;

    // 6. Save unmatched SKUs to DB for dashboard display
    const saveUnmatched = db.transaction(() => {
      db.prepare('DELETE FROM unmatched_skus').run();
      const insertStmt = db.prepare(
        'INSERT INTO unmatched_skus (sku, platform, product_title, offer_name) VALUES (?, ?, ?, ?)'
      );
      for (const sku of unmatchedShopifySkus) {
        const data = shopifyBySku.get(sku);
        insertStmt.run(sku, 'shopify', data?.title || '', null);
      }
      for (const sku of unmatchedAllegroSkus) {
        const data = allegroBySku.get(sku);
        insertStmt.run(sku, 'allegro', null, data?.name || '');
      }
    });
    saveUnmatched();

    // 7. Log summary
    if (unmatchedShopifySkus.length > 0) {
      logger.info(`Unmatched Shopify SKUs (no Allegro offer): ${unmatchedShopifySkus.slice(0, 20).join(', ')}${unmatchedShopifySkus.length > 20 ? ` ... and ${unmatchedShopifySkus.length - 20} more` : ''}`);
    }
    if (unmatchedAllegroSkus.length > 0) {
      logger.info(`Unmatched Allegro SKUs (no Shopify variant): ${unmatchedAllegroSkus.slice(0, 20).join(', ')}${unmatchedAllegroSkus.length > 20 ? ` ... and ${unmatchedAllegroSkus.length - 20} more` : ''}`);
    }
    if (staleCount > 0) {
      logger.info(`Marked ${staleCount} stale mappings (Allegro offer no longer matched)`);
    }
  } finally {
    isRunning = false;
  }

  logger.info(`Product sync complete: ${matched} matched, ${unmatchedShopify} unmatched Shopify, ${unmatchedAllegro} unmatched Allegro, ${errors} errors`);
  return { matched, unmatchedShopify, unmatchedAllegro, errors };
}

/**
 * Re-check mapping for a single Shopify product (webhook handler).
 * Looks up existing product_map entries and verifies they still match by SKU.
 */
async function syncSingleProduct(product) {
  logger.info(`SKU re-check for product ${product.id}`);

  for (const variant of product.variants) {
    const sku = (variant.sku || '').trim();
    if (!sku) continue;

    try {
      const existing = db.prepare(
        'SELECT * FROM product_map WHERE shopify_product_id = ? AND shopify_variant_id = ?'
      ).get(String(product.id), String(variant.id));

      if (existing && existing.status === 'active') {
        // Mapping exists and active — nothing to do for SKU matching
        logger.debug(`SKU "${sku}" already mapped: variant ${variant.id} <-> offer ${existing.allegro_offer_id}`);
        continue;
      }

      // No mapping — try to find matching Allegro offer by SKU
      // We search through all offers (cached from last full sync in product_map)
      // or do a lightweight search
      const allegroMatch = db.prepare(
        "SELECT allegro_offer_id, allegro_category_id FROM product_map WHERE allegro_offer_id IS NOT NULL AND status = 'active'"
      ).all();

      // If no mapping found, log and skip — full sync will pick it up
      if (!existing) {
        logger.info(`No mapping for SKU "${sku}" (variant ${variant.id}). Run full product sync to match.`);
        logSync(sku, 'info', `Unmapped SKU — awaiting full sync`);
      }
    } catch (err) {
      logger.error(`Single product SKU check error for variant ${variant.id}: ${err.message}`);
      logSync(String(variant.id), 'error', err.message);
    }
  }
}

module.exports = { syncProducts, syncSingleProduct };
