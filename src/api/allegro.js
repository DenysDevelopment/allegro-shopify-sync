const axios = require('axios');
const db = require('../../db');
const logger = require('../utils/logger');
const { allegroQueue } = require('../utils/queue');

class AllegroClient {
  constructor() {
    this.apiBase = process.env.ALLEGRO_SANDBOX === 'true'
      ? 'https://api.allegro.pl.allegrosandbox.pl'
      : (process.env.ALLEGRO_API_BASE || 'https://api.allegro.pl');

    this.authBase = process.env.ALLEGRO_SANDBOX === 'true'
      ? 'https://allegro.pl.allegrosandbox.pl/auth/oauth'
      : (process.env.ALLEGRO_AUTH_URL || 'https://allegro.pl/auth/oauth');

    this.clientId = process.env.ALLEGRO_CLIENT_ID;
    this.clientSecret = process.env.ALLEGRO_CLIENT_SECRET;

    this.client = axios.create({
      baseURL: this.apiBase,
      headers: {
        'Accept': 'application/vnd.allegro.public.v1+json',
        'Content-Type': 'application/vnd.allegro.public.v1+json',
      },
      timeout: 30000,
    });

    // Auto-attach fresh access token
    this.client.interceptors.request.use(async (config) => {
      const token = await this.getValidToken();
      config.headers['Authorization'] = `Bearer ${token}`;
      return config;
    });
  }

  getAuthUrl() {
    return `${this.authBase}/authorize?response_type=code&client_id=${this.clientId}&redirect_uri=${encodeURIComponent(process.env.ALLEGRO_REDIRECT_URI)}`;
  }

  async getValidToken() {
    const row = db.prepare('SELECT * FROM allegro_tokens WHERE id = 1').get();
    if (!row) throw new Error('No Allegro tokens found. Complete OAuth flow at /auth/allegro');

    // Refresh 5 minutes before expiry
    if (Date.now() / 1000 > row.expires_at - 300) {
      return this.refreshToken(row.refresh_token);
    }
    return row.access_token;
  }

  async refreshToken(refreshToken) {
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const res = await axios.post(
      `${this.authBase}/token`,
      `grant_type=refresh_token&refresh_token=${refreshToken}`,
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const { access_token, refresh_token, expires_in } = res.data;
    const expires_at = Math.floor(Date.now() / 1000) + expires_in;

    db.prepare(`
      INSERT INTO allegro_tokens (id, access_token, refresh_token, expires_at, updated_at)
      VALUES (1, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        updated_at = datetime('now')
    `).run(access_token, refresh_token, expires_at);

    logger.info('Allegro token refreshed successfully');
    return access_token;
  }

  async exchangeCode(code) {
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const res = await axios.post(
      `${this.authBase}/token`,
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(process.env.ALLEGRO_REDIRECT_URI)}`,
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const { access_token, refresh_token, expires_in } = res.data;
    const expires_at = Math.floor(Date.now() / 1000) + expires_in;

    db.prepare(`
      INSERT INTO allegro_tokens (id, access_token, refresh_token, expires_at, updated_at)
      VALUES (1, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        updated_at = datetime('now')
    `).run(access_token, refresh_token, expires_at);

    logger.info('Allegro OAuth completed successfully');
    return { access_token, refresh_token, expires_at };
  }

  // Product Offers
  async createProductOffer(offerData) {
    const res = await allegroQueue.add(
      () => this.client.post('/sale/product-offers', offerData),
      { label: 'Allegro createProductOffer' }
    );

    // Handle async 202 response
    if (res.status === 202 && res.headers.location) {
      return { id: null, location: res.headers.location };
    }
    return res.data;
  }

  async updateProductOffer(offerId, data) {
    const res = await allegroQueue.add(
      () => this.client.patch(`/sale/product-offers/${offerId}`, data),
      { label: `Allegro updateProductOffer ${offerId}` }
    );
    return res.data;
  }

  async getOfferStatus(offerId) {
    const res = await allegroQueue.add(
      () => this.client.get(`/sale/product-offers/${offerId}`),
      { label: `Allegro getOfferStatus ${offerId}` }
    );
    return res.data;
  }

  async pollOperationStatus(locationUrl, maxAttempts = 30, interval = 2000) {
    for (let i = 0; i < maxAttempts; i++) {
      const res = await this.client.get(locationUrl);
      if (res.status === 200) return res.data;
      if (res.status === 202) {
        await new Promise(r => setTimeout(r, interval));
        continue;
      }
      throw new Error(`Unexpected status ${res.status} polling ${locationUrl}`);
    }
    throw new Error(`Polling timed out for ${locationUrl}`);
  }

  // Prices
  async changePriceCommand(offerId, commandId, priceData) {
    const res = await allegroQueue.add(
      () => this.client.put(`/offers/${offerId}/change-price-commands/${commandId}`, priceData),
      { label: `Allegro changePriceCommand ${offerId}` }
    );
    return res.data;
  }

  // Stock
  async updateOfferStock(offerId, quantity) {
    const res = await allegroQueue.add(
      () => this.client.patch(`/sale/product-offers/${offerId}`, {
        stock: { available: quantity, unit: 'UNIT' },
      }),
      { label: `Allegro updateOfferStock ${offerId}` }
    );
    return res.data;
  }

  // Orders
  async getCheckoutForms(params = {}) {
    const res = await allegroQueue.add(
      () => this.client.get('/order/checkout-forms', { params }),
      { label: 'Allegro getCheckoutForms' }
    );
    return res.data;
  }

  // Categories
  async getCategories(parentId = null) {
    const params = parentId ? { 'parent.id': parentId } : {};
    const res = await allegroQueue.add(
      () => this.client.get('/sale/categories', { params }),
      { label: 'Allegro getCategories' }
    );
    return res.data;
  }

  async getCategoryParameters(categoryId) {
    const res = await allegroQueue.add(
      () => this.client.get(`/sale/categories/${categoryId}/parameters`),
      { label: `Allegro getCategoryParameters ${categoryId}` }
    );
    return res.data;
  }

  // List all seller's offers (paginated)
  async getAllOffers() {
    let allOffers = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      const res = await allegroQueue.add(
        () => this.client.get('/sale/offers', {
          params: { offset, limit, 'publication.status': 'ACTIVE' },
        }),
        { label: `Allegro getAllOffers offset=${offset}` }
      );

      const offers = res.data.offers || [];
      allOffers.push(...offers);

      if (offers.length < limit) break;
      offset += limit;
      if (offset >= 10000) break; // Allegro limit
    }

    logger.info(`Fetched ${allOffers.length} offers from Allegro`);
    return allOffers;
  }

  isConnected() {
    const row = db.prepare('SELECT expires_at FROM allegro_tokens WHERE id = 1').get();
    return row && (row.expires_at > Date.now() / 1000);
  }
}

module.exports = new AllegroClient();
