const { v4: uuidv4 } = require('uuid');
const db = require('../../db');
const shopify = require('../api/shopify');
const allegro = require('../api/allegro');
const logger = require('../utils/logger');

let isRunning = false;

function calculateAllegroPrice(shopifyPrice) {
  const multiplier = parseFloat(process.env.PRICE_MULTIPLIER || '1.0');
  const offset = parseFloat(process.env.PRICE_OFFSET || '0');
  const shouldRound = process.env.PRICE_ROUND !== 'false';

  let price = parseFloat(shopifyPrice) * multiplier + offset;

  if (shouldRound) {
    price = Math.floor(price) + 0.99;
  }

  return price.toFixed(2);
}

function logSync(entityId, status, message) {
  db.prepare(
    'INSERT INTO sync_log (sync_type, direction, entity_id, status, message) VALUES (?, ?, ?, ?, ?)'
  ).run('prices', 'shopify_to_allegro', entityId, status, message);
}

async function syncPrices() {
  if (isRunning) {
    logger.warn('Price sync already running, skipping');
    return;
  }

  isRunning = true;
  logger.info('Starting price sync: Shopify -> Allegro');

  let synced = 0, errors = 0;

  try {
    const mappings = db.prepare(
      "SELECT * FROM product_map WHERE status = 'active' AND allegro_offer_id IS NOT NULL"
    ).all();

    for (const mapping of mappings) {
      try {
        const variant = await shopify.getVariant(mapping.shopify_variant_id);
        const newPrice = calculateAllegroPrice(variant.price);
        const commandId = uuidv4();

        await allegro.changePriceCommand(mapping.allegro_offer_id, commandId, {
          input: {
            buyNowPrice: { amount: newPrice, currency: 'PLN' },
          },
        });

        logSync(mapping.allegro_offer_id, 'success', `Price set to ${newPrice} PLN`);
        synced++;
      } catch (err) {
        errors++;
        logger.error(`Price sync error for offer ${mapping.allegro_offer_id}: ${err.message}`);
        logSync(mapping.allegro_offer_id, 'error', err.message);
      }
    }
  } finally {
    isRunning = false;
  }

  logger.info(`Price sync complete: ${synced} synced, ${errors} errors`);
  return { synced, errors };
}

module.exports = { syncPrices, calculateAllegroPrice };
