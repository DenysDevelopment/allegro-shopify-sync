require('dotenv').config();
const shopify = require('../src/api/shopify');
const logger = require('../src/utils/logger');

const APP_URL = process.env.APP_URL;

if (!APP_URL) {
  console.error('APP_URL must be set in .env (e.g., https://your-ngrok-url.ngrok.io)');
  process.exit(1);
}

const WEBHOOK_TOPICS = [
  { topic: 'products/update', path: '/webhooks/products-update' },
  { topic: 'products/delete', path: '/webhooks/products-delete' },
  { topic: 'inventory_levels/update', path: '/webhooks/inventory_levels-update' },
  { topic: 'orders/paid', path: '/webhooks/orders-paid' },
  { topic: 'orders/cancelled', path: '/webhooks/orders-cancelled' },
  { topic: 'refunds/create', path: '/webhooks/refunds-create' },
];

async function registerWebhooks() {
  console.log(`Registering webhooks with base URL: ${APP_URL}\n`);

  // List existing webhooks
  const existing = await shopify.getWebhooks();
  console.log(`Found ${existing.length} existing webhooks\n`);

  for (const { topic, path } of WEBHOOK_TOPICS) {
    const address = `${APP_URL}${path}`;

    // Check if already registered
    const alreadyExists = existing.find(w => w.topic === topic && w.address === address);
    if (alreadyExists) {
      console.log(`[SKIP] ${topic} -> ${address} (already registered)`);
      continue;
    }

    try {
      const webhook = await shopify.createWebhook(topic, address);
      console.log(`[OK] ${topic} -> ${address} (id: ${webhook.id})`);
    } catch (err) {
      console.error(`[ERROR] ${topic}: ${err.response?.data?.errors || err.message}`);
    }
  }

  console.log('\nDone.');
}

registerWebhooks().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
