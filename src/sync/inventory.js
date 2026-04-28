const db = require('../../db');
const shopify = require('../api/shopify');
const allegro = require('../api/allegro');
const logger = require('../utils/logger');

let isRunning = false;

function logSync(direction, entityId, status, message) {
  db.prepare(
    'INSERT INTO sync_log (sync_type, direction, entity_id, status, message) VALUES (?, ?, ?, ?, ?)'
  ).run('inventory', direction, entityId, status, message);
}

async function syncInventory() {
  if (isRunning) {
    logger.warn('Inventory sync already running, skipping');
    return;
  }

  isRunning = true;
  logger.info('Starting inventory sync (bidirectional)');

  let shopifyToAllegro = 0, allegroToShopify = 0, inSync = 0, errors = 0;

  try {
    const mappings = db.prepare(
      "SELECT * FROM product_map WHERE status = 'active' AND allegro_offer_id IS NOT NULL"
    ).all();

    for (const mapping of mappings) {
      try {
        // Fetch both sides
        const [shopifyVariant, allegroOffer] = await Promise.all([
          shopify.getVariant(mapping.shopify_variant_id),
          allegro.getOfferStatus(mapping.allegro_offer_id),
        ]);

        const shopifyQty = shopifyVariant.inventory_quantity || 0;
        const allegroQty = allegroOffer.stock?.available ?? 0;

        if (shopifyQty === allegroQty) {
          inSync++;
          continue;
        }

        // Last-Write-Wins: compare timestamps
        const shopifyUpdated = new Date(shopifyVariant.updated_at).getTime();
        const allegroUpdated = new Date(allegroOffer.updatedAt || 0).getTime();

        if (shopifyUpdated >= allegroUpdated) {
          // Shopify wins -> push to Allegro
          await allegro.updateOfferStock(mapping.allegro_offer_id, shopifyQty);
          logSync('shopify_to_allegro', mapping.allegro_offer_id, 'success',
            `Stock set to ${shopifyQty} (was ${allegroQty})`);
          shopifyToAllegro++;
        } else {
          // Allegro wins -> push to Shopify
          const adjustment = allegroQty - shopifyQty;
          await shopify.adjustInventory(
            shopifyVariant.inventory_item_id,
            process.env.SHOPIFY_LOCATION_ID,
            adjustment
          );
          logSync('allegro_to_shopify', mapping.shopify_variant_id, 'success',
            `Stock adjusted by ${adjustment} (now ${allegroQty})`);
          allegroToShopify++;
        }
      } catch (err) {
        errors++;
        logger.error(`Inventory sync error for mapping ${mapping.id}: ${err.message}`);
        logSync('bidirectional', String(mapping.id), 'error', err.message);
      }
    }
  } finally {
    isRunning = false;
  }

  logger.info(`Inventory sync complete: ${shopifyToAllegro} S->A, ${allegroToShopify} A->S, ${inSync} in-sync, ${errors} errors`);
  return { shopifyToAllegro, allegroToShopify, inSync, errors };
}

// Sync a single item (used by webhook handler)
async function syncSingleItem(inventoryItemId, available) {
  logger.info(`Syncing single inventory item ${inventoryItemId}`);

  // Find mapping by looking up the variant with this inventory_item_id
  // We need to find the shopify_variant_id first
  const mappings = db.prepare(
    "SELECT * FROM product_map WHERE status = 'active' AND allegro_offer_id IS NOT NULL"
  ).all();

  for (const mapping of mappings) {
    try {
      const variant = await shopify.getVariant(mapping.shopify_variant_id);
      if (String(variant.inventory_item_id) === String(inventoryItemId)) {
        // Found the matching mapping, push to Allegro
        await allegro.updateOfferStock(mapping.allegro_offer_id, available);
        logSync('shopify_to_allegro', mapping.allegro_offer_id, 'success',
          `Webhook: stock set to ${available}`);
        logger.info(`Inventory webhook: updated Allegro offer ${mapping.allegro_offer_id} to ${available}`);
        return;
      }
    } catch (err) {
      logger.error(`Inventory single item sync error: ${err.message}`);
    }
  }

  logger.warn(`No mapping found for inventory_item_id ${inventoryItemId}`);
}

module.exports = { syncInventory, syncSingleItem };
