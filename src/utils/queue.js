const logger = require('./logger');

class TaskQueue {
  constructor({ concurrency = 1, retries = 3, baseDelay = 1000 } = {}) {
    this.concurrency = concurrency;
    this.retries = retries;
    this.baseDelay = baseDelay;
    this.running = 0;
    this.queue = [];
  }

  async add(taskFn, { label = 'task', priority = 0 } = {}) {
    if (this.running >= this.concurrency) {
      await new Promise(resolve => {
        this.queue.push({ resolve, priority });
        this.queue.sort((a, b) => b.priority - a.priority);
      });
    }

    this.running++;
    try {
      return await this._executeWithRetry(taskFn, 0, this.retries, this.baseDelay, label);
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next.resolve();
      }
    }
  }

  async _executeWithRetry(taskFn, attempt, maxRetries, baseDelay, label) {
    try {
      return await taskFn();
    } catch (err) {
      const status = err.response?.status;

      // Don't retry 4xx client errors (except 429)
      if (status && status >= 400 && status < 500 && status !== 429) {
        logger.error(`[Queue] ${label} failed with ${status}: ${err.message}`);
        throw err;
      }

      if (attempt >= maxRetries) {
        logger.error(`[Queue] ${label} exhausted ${maxRetries} retries: ${err.message}`);
        throw err;
      }

      let waitMs;
      if (status === 429) {
        const retryAfter = parseInt(err.response.headers?.['retry-after'] || '1', 10);
        waitMs = retryAfter * 1000;
        logger.warn(`[Queue] ${label} rate limited (429). Waiting ${retryAfter}s (attempt ${attempt + 1}/${maxRetries})`);
      } else {
        waitMs = baseDelay * Math.pow(2, attempt);
        logger.warn(`[Queue] ${label} error: ${err.message}. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      }

      await this._sleep(waitMs);
      return this._executeWithRetry(taskFn, attempt + 1, maxRetries, baseDelay, label);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Shopify queue: 2 req/sec (conservative)
const shopifyQueue = new TaskQueue({ concurrency: 1, retries: 3, baseDelay: 1000 });

// Allegro queue: higher throughput allowed
const allegroQueue = new TaskQueue({ concurrency: 3, retries: 5, baseDelay: 1000 });

module.exports = { TaskQueue, shopifyQueue, allegroQueue };
