#!/usr/bin/env node
// CLI the agent itself runs (via Bash) to talk to the teammate's agent:
//   node hooks/notify.mjs "Renaming getUser → fetchUser across src/ — adapt callers"
// Posts to #dev-sync in Kylon mode, mirrors to the shared dir in dry-run mode.
import { loadConfig } from "./lib/config.mjs";
import { currentBranch } from "./lib/git.mjs";
import { postMessage } from "./lib/kylon.mjs";

const text = process.argv.slice(2).join(" ").trim();
if (!text) {
  console.error('usage: node notify.mjs "<message to teammate>"');
  process.exit(1);
}
const cfg = loadConfig(process.cwd());
postMessage(cfg, `🤖 ${cfg.dev}'s agent (\`${currentBranch(cfg.repoRoot)}\`): ${text}`);
console.log(`[collab] posted to #${cfg.channel}${cfg.dryRun ? " (dry-run mirror)" : ""}`);
