const winston = require('winston');
const Transport = require('winston-transport');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(__dirname, '..', '..', 'logs');
fs.mkdirSync(logsDir, { recursive: true });

// Ring buffer for in-memory log access (dashboard /logs page)
const MAX_BUFFER = 500;
const logBuffer = [];

class MemoryTransport extends Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    logBuffer.push({
      timestamp: info.timestamp,
      level: info.level,
      message: info.stack || info.message,
    });
    while (logBuffer.length > MAX_BUFFER) logBuffer.shift();
    callback();
  }
}

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) =>
    `${timestamp} [${level.toUpperCase()}] ${stack || message}`
  )
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: fileFormat,
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new MemoryTransport(),
  ],
});

// Console always on (needed for PM2 log capture in production)
logger.add(new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, stack }) =>
      `${timestamp} ${level}: ${stack || message}`
    )
  ),
}));

module.exports = logger;
module.exports.getLogBuffer = () => logBuffer;
