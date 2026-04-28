module.exports = {
  apps: [{
    name: 'gurulinker',
    script: 'index.js',
    instances: 1, // SQLite cannot handle multiple process writers
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env_production: {
      NODE_ENV: 'production',
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }],
};
