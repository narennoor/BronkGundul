const path = require("path");

const repoRoot = __dirname;

// The pm2 app name follows the repo directory name, so several copies of this
// repo (CopetGundul, BronkGundul, …) can run side by side on one box without
// colliding. Keep pm2:restart / pm2:logs in package.json deriving it the same way.
const appName = path.basename(repoRoot);

module.exports = {
  apps: [
    {
      name: appName,
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      // Always start via this file (npm run pm2:start) so cwd + script path stay pinned to the repo.
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};