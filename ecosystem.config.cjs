// pm2 config. Node 22 is REQUIRED (better-sqlite3 prebuilt breaks on Node 24) —
// the interpreter and PATH below pin it explicitly (PLAN §16.10): pm2 on
// Windows does not inherit the shell PATH, so it must live here.
//
// Both apps run BUILT output, never dev mode (IMPL-4 §7.1 pitfall):
//   wick-server → apps/server/dist/index.js   (`pnpm --filter @wick/server build`)
//   wick-web    → next start                  (`pnpm --filter @wick/web build`)
// `pnpm build` does both; `pnpm pm2:start` runs it first.
//
// NODE_ENV=production also matters for the server beyond Next: util/logger.ts
// only attaches the pino-pretty transport in non-production, and that worker
// crashes when pm2 redirects stdout to a file.
//
// Log rotation is NOT part of this file — it is a one-time pm2 module install
// (see README "Run it as a service"):
//   pm2 install pm2-logrotate
//   pm2 set pm2-logrotate:max_size 10M
//   pm2 set pm2-logrotate:retain 5
const NODE22_DIR = 'D:/Claude/Tools/node-v22';
const ROOT = 'D:/Projects/Wick';
const NODE22 = `${NODE22_DIR}/node.exe`;
const PATH_WITH_NODE22 = `${NODE22_DIR};${process.env.PATH || ''}`;

/** Shared restart policy: 10 fast restarts max, exponential backoff between. */
const restartPolicy = {
  autorestart: true,
  max_restarts: 10,
  exp_backoff_restart_delay: 3000, // 3s, doubling up to ~15s between crashes
  min_uptime: 20_000,              // under this, a start counts as a crash
  max_memory_restart: '1G',
  watch: false,
  instances: 1,
  exec_mode: 'fork',
  time: true,
};

module.exports = {
  apps: [
    {
      name: 'wick-server',
      script: './apps/server/dist/index.js',
      cwd: ROOT,
      interpreter: NODE22,
      ...restartPolicy,
      env: {
        NODE_ENV: 'production',
        PATH: PATH_WITH_NODE22,
      },
      out_file: `${ROOT}/logs/server-out.log`,
      error_file: `${ROOT}/logs/server-err.log`,
    },
    {
      name: 'wick-web',
      // next's own JS entry — pm2 must not spawn the .cmd shim on Windows.
      script: './node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 127.0.0.1',
      cwd: `${ROOT}/apps/web`,
      interpreter: NODE22,
      ...restartPolicy,
      env: {
        NODE_ENV: 'production',
        PATH: PATH_WITH_NODE22,
      },
      out_file: `${ROOT}/logs/web-out.log`,
      error_file: `${ROOT}/logs/web-err.log`,
    },
  ],
};
