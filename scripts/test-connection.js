require('dotenv').config();
const axios = require('axios');

async function testShopify() {
  console.log('--- Shopify Connection Test ---');
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2024-01';

  if (!store || !token) {
    console.log('[FAIL] SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN not set in .env');
    return false;
  }

  try {
    const res = await axios.get(`https://${store}/admin/api/${version}/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const shop = res.data.shop;
    console.log(`[OK] Store: ${shop.name}`);
    console.log(`     Domain: ${shop.myshopify_domain}`);
    console.log(`     Plan: ${shop.plan_name}`);
    console.log(`     Currency: ${shop.currency}`);
    return true;
  } catch (err) {
    console.log(`[FAIL] ${err.response?.status || 'Network error'}: ${err.message}`);
    return false;
  }
}

async function testAllegro() {
  console.log('\n--- Allegro Connection Test ---');
  const clientId = process.env.ALLEGRO_CLIENT_ID;
  const clientSecret = process.env.ALLEGRO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log('[FAIL] ALLEGRO_CLIENT_ID or ALLEGRO_CLIENT_SECRET not set in .env');
    return false;
  }

  // Check if we have stored tokens
  try {
    const db = require('../db');
    const row = db.prepare('SELECT * FROM allegro_tokens WHERE id = 1').get();

    if (!row) {
      console.log('[WARN] No Allegro tokens found. Complete OAuth at http://localhost:3000/auth/allegro');
      return false;
    }

    const now = Date.now() / 1000;
    if (row.expires_at < now) {
      console.log('[WARN] Allegro token expired. Attempting refresh...');

      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const isSandbox = process.env.ALLEGRO_SANDBOX === 'true';
      const authBase = isSandbox
        ? 'https://allegro.pl.allegrosandbox.pl/auth/oauth'
        : (process.env.ALLEGRO_AUTH_URL || 'https://allegro.pl/auth/oauth');

      const res = await axios.post(
        `${authBase}/token`,
        `grant_type=refresh_token&refresh_token=${row.refresh_token}`,
        {
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      console.log('[OK] Token refreshed successfully');
    } else {
      console.log(`[OK] Token valid (expires in ${Math.round((row.expires_at - now) / 3600)}h)`);
    }

    // Test API call
    const isSandbox = process.env.ALLEGRO_SANDBOX === 'true';
    const apiBase = isSandbox
      ? 'https://api.allegro.pl.allegrosandbox.pl'
      : (process.env.ALLEGRO_API_BASE || 'https://api.allegro.pl');

    const tokenRow = db.prepare('SELECT access_token FROM allegro_tokens WHERE id = 1').get();
    const res = await axios.get(`${apiBase}/me`, {
      headers: {
        'Authorization': `Bearer ${tokenRow.access_token}`,
        'Accept': 'application/vnd.allegro.public.v1+json',
      },
      timeout: 10000,
    });

    console.log(`[OK] Allegro user: ${res.data.login || res.data.id}`);
    console.log(`     Sandbox: ${isSandbox}`);
    return true;
  } catch (err) {
    console.log(`[FAIL] ${err.response?.status || 'Error'}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('GuruLINKER Connection Test\n');

  const shopifyOk = await testShopify();
  const allegroOk = await testAllegro();

  console.log('\n--- Summary ---');
  console.log(`Shopify:  ${shopifyOk ? 'OK' : 'FAILED'}`);
  console.log(`Allegro:  ${allegroOk ? 'OK' : 'FAILED'}`);

  process.exit(shopifyOk && allegroOk ? 0 : 1);
}

main();
