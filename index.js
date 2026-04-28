require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const logger = require('./src/utils/logger');

const app = express();

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Body parsing with raw body capture for webhook HMAC verification
app.use(
	express.json({
		verify: (req, res, buf) => {
			req.rawBody = buf.toString();
		},
	}),
);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Allow Shopify Admin to embed this app in an iframe
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.myshopify.com https://admin.shopify.com"
  );
  next();
});

// Routes
app.use('/auth', require('./src/routes/auth'));
app.use('/webhooks', require('./src/routes/webhooks'));
app.use('/dashboard', require('./src/routes/dashboard'));
app.get('/', (req, res) => res.redirect('/dashboard'));

// Health check
app.get('/health', (req, res) => {
	try {
		db.prepare('SELECT 1').get();
		const token = db
			.prepare('SELECT expires_at FROM allegro_tokens WHERE id = 1')
			.get();
		const tokenValid = token && token.expires_at > Date.now() / 1000;

		res.json({
			status: 'ok',
			uptime: process.uptime(),
			database: 'connected',
			allegro_token: tokenValid ? 'valid' : 'expired_or_missing',
			memory: process.memoryUsage(),
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		res.status(503).json({ status: 'error', message: err.message });
	}
});

// Cron jobs
const productSync = require('./src/sync/products');
const inventorySync = require('./src/sync/inventory');
const orderSync = require('./src/sync/orders');
const allegro = require('./src/api/allegro');

const cronTasks = [];

// Inventory: every minute (bidirectional — Allegro purchase → Shopify stock decrease)
cronTasks.push(
	cron.schedule('* * * * *', async () => {
		try {
			await inventorySync.syncInventory();
		} catch (err) {
			logger.error(`Cron inventory error: ${err.message}`);
		}
	}),
);

// Orders: every minute (Allegro → Shopify draft orders)
cronTasks.push(
	cron.schedule('* * * * *', async () => {
		try {
			await orderSync.syncOrders();
		} catch (err) {
			logger.error(`Cron order error: ${err.message}`);
		}
	}),
);

// Products: every minute (SKU matching)
cronTasks.push(
	cron.schedule('* * * * *', async () => {
		try {
			await productSync.syncProducts();
		} catch (err) {
			logger.error(`Cron product error: ${err.message}`);
		}
	}),
);

// Token refresh: every 11 hours
cronTasks.push(
	cron.schedule('0 */11 * * *', async () => {
		try {
			const row = db
				.prepare('SELECT refresh_token FROM allegro_tokens WHERE id = 1')
				.get();
			if (row) await allegro.refreshToken(row.refresh_token);
		} catch (err) {
			logger.error(`Cron token refresh error: ${err.message}`);
		}
	}),
);

// Start server
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
	logger.info(`GuruLINKER running on ${process.env.APP_URL || `http://localhost:${PORT}`}`);
});

// Graceful shutdown
async function gracefulShutdown(signal) {
	logger.info(`${signal} received. Shutting down gracefully...`);
	cronTasks.forEach(task => task.stop());
	server.close(() => {
		logger.info('HTTP server closed');
		db.close();
		logger.info('Database connection closed');
		process.exit(0);
	});
	setTimeout(() => {
		logger.error('Forced shutdown after timeout');
		process.exit(1);
	}, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', reason => {
	logger.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', err => {
	logger.error('Uncaught Exception:', err);
	gracefulShutdown('uncaughtException');
});
