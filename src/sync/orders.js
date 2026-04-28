const db = require('../../db');
const shopify = require('../api/shopify');
const allegro = require('../api/allegro');
const logger = require('../utils/logger');

let isRunning = false;

function logSync(entityId, status, message) {
	db.prepare(
		'INSERT INTO sync_log (sync_type, direction, entity_id, status, message) VALUES (?, ?, ?, ?, ?)',
	).run('orders', 'allegro_to_shopify', entityId, status, message);
}

function buildDraftOrder(allegroOrder) {
	const lineItems = (allegroOrder.lineItems || []).map(item => {
		// Try to find the matching Shopify variant from product_map
		const mapping = db
			.prepare('SELECT * FROM product_map WHERE allegro_offer_id = ?')
			.get(item.offer?.id);

		if (mapping) {
			return {
				variant_id: parseInt(mapping.shopify_variant_id, 10),
				quantity: item.quantity,
			};
		}

		// Fallback: custom line item (no variant match)
		return {
			title: item.offer?.name || 'Allegro Item',
			price: item.price?.amount || '0.00',
			quantity: item.quantity,
		};
	});

	const buyer = allegroOrder.buyer || {};
	const delivery = allegroOrder.delivery?.address || {};

	return {
		draft_order: {
			line_items: lineItems,
			customer: {
				first_name: buyer.firstName || delivery.firstName || '',
				last_name: buyer.lastName || delivery.lastName || '',
				email: buyer.email || `allegro-${allegroOrder.id}@placeholder.local`,
			},
			shipping_address: {
				first_name: delivery.firstName || buyer.firstName || '',
				last_name: delivery.lastName || buyer.lastName || '',
				address1: delivery.street || '',
				city: delivery.city || '',
				zip: delivery.zipCode || delivery.postCode || '',
				country_code: delivery.countryCode || 'PL',
				phone: delivery.phoneNumber || '',
			},
			note: `Imported from Allegro. Order ID: ${allegroOrder.id}`,
			tags: 'allegro-import',
		},
	};
}

async function syncOrders() {
	if (isRunning) {
		logger.warn('Order sync already running, skipping');
		return;
	}

	isRunning = true;
	logger.info('Starting order sync: Allegro -> Shopify');

	let imported = 0,
		skipped = 0,
		errors = 0;

	try {
		// Fetch recent orders (last 24 hours)
		const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		// Fetch all recent orders (no status filter) to catch all states
		const result = await allegro.getCheckoutForms({
			'updatedAt.gte': since,
			limit: 100,
		});

		const checkoutForms = result.checkoutForms || [];

		logger.info(`Found ${checkoutForms.length} Allegro orders`);

		for (const order of checkoutForms) {
			try {
				// Skip cancelled orders
				if (order.status === 'CANCELLED') {
					skipped++;
					continue;
				}

				// Deduplication check
				const existing = db
					.prepare('SELECT * FROM order_map WHERE allegro_order_id = ?')
					.get(order.id);

				if (existing) {
					skipped++;
					continue;
				}

				// Build and create draft order
				const draftOrderData = buildDraftOrder(order);
				const draft = await shopify.createDraftOrder(draftOrderData);

				// Complete draft order → real order (marks as paid)
				const completed = await shopify.completeDraftOrder(draft.id, {
					payment_pending: false,
				});
				const shopifyOrderId = String(completed.order_id || draft.id);

				// Record mapping
				db.prepare(
					`
          INSERT INTO order_map (allegro_order_id, shopify_order_id, buyer_email, total_amount, status)
          VALUES (?, ?, ?, ?, 'imported')
        `,
				).run(
					order.id,
					shopifyOrderId,
					order.buyer?.email || '',
					parseFloat(order.summary?.totalToPay?.amount || 0),
				);

				logSync(
					order.id,
					'success',
					`Imported as Shopify order ${shopifyOrderId}`,
				);
				imported++;
				logger.info(
					`Order ${order.id} (${order.status}) → Shopify order ${shopifyOrderId}`,
				);
			} catch (err) {
				errors++;
				logger.error(`Order import error for ${order.id}: ${err.message}`);
				logSync(order.id, 'error', err.message);
			}
		}
	} finally {
		isRunning = false;
	}

	logger.info(
		`Order sync complete: ${imported} imported, ${skipped} skipped, ${errors} errors`,
	);
	return { imported, skipped, errors };
}

module.exports = { syncOrders };
