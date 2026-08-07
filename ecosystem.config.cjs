// pm2 config. Node 22 is REQUIRED (better-sqlite3 prebuilt breaks on Node 24) —
// the interpreter and PATH below pin it explicitly (PLAN §16.10): pm2 on
// Windows does not inherit the shell PATH, so it must live here.
const NODE22_DIR = 'D:/Claude/Tools/node-v22';

module.exports = {
  apps: [
    {
      name: 'wick-server',
      script: './apps/server/dist/index.js',
      cwd: 'D:/Projects/Wick',
      interpreter: `${NODE22_DIR}/node.exe`,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      autorestart: true,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PATH: `${NODE22_DIR};${process.env.PATH || ''}`,
      },
      out_file: 'D:/Projects/Wick/logs/out.log',
      error_file: 'D:/Projects/Wick/logs/err.log',
      time: true,
    },
  ],
};
