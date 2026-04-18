module.exports = {
  apps: [
    {
      name: 'cockpit-server',
      script: './apps/server/dist/index.js',
      cwd: 'D:/Claude/trading-cockpit',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      autorestart: true,
      restart_delay: 3000,
      env: { NODE_ENV: 'production' },
      out_file: 'D:/Claude/trading-cockpit/logs/out.log',
      error_file: 'D:/Claude/trading-cockpit/logs/err.log',
      time: true,
    },
  ],
};
