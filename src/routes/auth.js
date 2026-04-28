const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const db = require('../../db');
const allegro = require('../api/allegro');
const logger = require('../utils/logger');

// ==================== SHOPIFY OAuth ====================

router.get('/shopify', (req, res) => {
  const store = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const scopes = process.env.SHOPIFY_SCOPES || 'read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_draft_orders,write_draft_orders';
  const redirectUri = `${process.env.APP_URL}/auth/shopify/callback`;
  const nonce = crypto.randomBytes(16).toString('hex');

  const authUrl = `https://${store}/admin/oauth/authorize?` +
    `client_id=${clientId}&` +
    `scope=${scopes}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `state=${nonce}`;

  logger.info('Redirecting to Shopify OAuth');
  res.redirect(authUrl);
});

router.get('/shopify/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    logger.error('Shopify OAuth callback: no code received');
    return res.redirect('/dashboard?error=shopify_no_code');
  }

  try {
    const tokenRes = await axios.post(
      `https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`,
      {
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code: code,
      }
    );

    const { access_token, scope } = tokenRes.data;

    db.prepare(`
      INSERT INTO shopify_tokens (id, access_token, scope, updated_at)
      VALUES (1, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token,
        scope = excluded.scope,
        updated_at = datetime('now')
    `).run(access_token, scope);

    logger.info(`Shopify OAuth completed. Token: shpat_... Scopes: ${scope}`);
    res.redirect('/dashboard?success=shopify_auth_complete');
  } catch (err) {
    logger.error(`Shopify OAuth failed: ${err.response?.data?.error || err.message}`);
    res.redirect('/dashboard?error=shopify_token_failed');
  }
});

// ==================== ALLEGRO OAuth ====================

router.get('/allegro', (req, res) => {
  const authUrl = allegro.getAuthUrl();
  logger.info('Redirecting to Allegro OAuth');
  res.redirect(authUrl);
});

router.get('/allegro/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    logger.error(`Allegro OAuth error: ${error}`);
    return res.redirect('/dashboard?error=auth_failed');
  }

  if (!code) {
    logger.error('Allegro OAuth callback: no code received');
    return res.redirect('/dashboard?error=no_code');
  }

  try {
    await allegro.exchangeCode(code);
    res.redirect('/dashboard?success=allegro_auth_complete');
  } catch (err) {
    logger.error(`Allegro OAuth token exchange failed: ${err.message}`);
    res.redirect('/dashboard?error=token_exchange_failed');
  }
});

module.exports = router;
