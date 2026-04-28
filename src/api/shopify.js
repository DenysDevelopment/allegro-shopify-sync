const axios = require('axios');
const db = require('../../db');
const logger = require('../utils/logger');
const { shopifyQueue } = require('../utils/queue');

class ShopifyClient {
  constructor() {
    this.store = process.env.SHOPIFY_STORE;
    this.apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';
    this.baseURL = `https://${this.store}/admin/api/${this.apiVersion}`;
  }

  _getAccessToken() {
    // First check DB (from OAuth flow)
    const row = db.prepare('SELECT access_token FROM shopify_tokens WHERE id = 1').get();
    if (row?.access_token) return row.access_token;

    // Fallback to .env (for manual token setup)
    if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;

    throw new Error('No Shopify access token. Complete OAuth at /auth/shopify');
  }

  _getClient() {
    const token = this._getAccessToken();
    return axios.create({
      baseURL: this.baseURL,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  async _request(method, url, data, label) {
    return shopifyQueue.add(async () => {
      const client = this._getClient();
      const res = await client[method](url, data);

      const callLimit = res.headers['x-shopify-shop-api-call-limit'];
      if (callLimit) {
        logger.debug(`Shopify rate: ${callLimit}`);
        const [current] = callLimit.split('/').map(Number);
        if (current > 35) {
          logger.warn(`Shopify rate limit approaching: ${callLimit}`);
        }
      }
      return res;
    }, { label: label || `Shopify ${method} ${url}` });
  }

  isConnected() {
    try {
      this._getAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  // Cursor-based pagination via Link header
  async getAllProducts() {
    let products = [];
    let url = '/products.json?limit=250';

    while (url) {
      const res = await this._request('get', url, undefined, 'Shopify getAllProducts');
      products.push(...res.data.products);
      url = this._getNextPageUrl(res.headers.link);
    }

    logger.info(`Fetched ${products.length} products from Shopify`);
    return products;
  }

  async getProduct(productId) {
    const res = await this._request('get', `/products/${productId}.json`, undefined, `Shopify getProduct ${productId}`);
    return res.data.product;
  }

  async getVariant(variantId) {
    const res = await this._request('get', `/variants/${variantId}.json`, undefined, `Shopify getVariant ${variantId}`);
    return res.data.variant;
  }

  async getInventoryLevels(inventoryItemIds) {
    const ids = Array.isArray(inventoryItemIds) ? inventoryItemIds.join(',') : inventoryItemIds;
    const res = await this._request('get', `/inventory_levels.json?inventory_item_ids=${ids}`, undefined, 'Shopify getInventoryLevels');
    return res.data.inventory_levels;
  }

  async adjustInventory(inventoryItemId, locationId, adjustment) {
    const res = await this._request('post', '/inventory_levels/adjust.json', {
      inventory_item_id: parseInt(inventoryItemId, 10),
      location_id: parseInt(locationId, 10),
      available_adjustment: adjustment,
    }, `Shopify adjustInventory ${inventoryItemId} by ${adjustment}`);
    return res.data.inventory_level;
  }

  async createDraftOrder(orderData) {
    const res = await this._request('post', '/draft_orders.json', orderData, 'Shopify createDraftOrder');
    return res.data.draft_order;
  }

  async completeDraftOrder(draftOrderId, options = {}) {
    const res = await this._request('put', `/draft_orders/${draftOrderId}/complete.json`, options, `Shopify completeDraftOrder ${draftOrderId}`);
    return res.data.draft_order;
  }

  async createWebhook(topic, address) {
    const res = await this._request('post', '/webhooks.json', {
      webhook: { topic, address, format: 'json' },
    }, `Shopify createWebhook ${topic}`);
    return res.data.webhook;
  }

  async getWebhooks() {
    const res = await this._request('get', '/webhooks.json', undefined, 'Shopify getWebhooks');
    return res.data.webhooks;
  }

  async getShop() {
    const res = await this._request('get', '/shop.json', undefined, 'Shopify getShop');
    return res.data.shop;
  }

  _getNextPageUrl(linkHeader) {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (!match) return null;
    return match[1].replace(this.baseURL, '');
  }
}

module.exports = new ShopifyClient();
