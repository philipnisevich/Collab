#!/usr/bin/env node
// CLI the agent itself runs (via Bash) to talk to the teammate's agent:
//   node hooks/notify.mjs "Renaming getUser → fetchUser across src/ — adapt callers"
// If the message mentions a file with an open conflict-negotiation thread
// (opened on the ⚠️ alert in #dev-sync), the update is posted INTO that thread
// so the negotiation stays organized; otherwise it goes to the channel.
// Dry-run mode mirrors to the shared dir as before.
import { loadConfig } from "./lib/config.mjs";
import { currentBranch } from "./lib/git.mjs";
import { postMessage, conflictThreadFor, postToThread } from "./lib/kylon.mjs";

const text = process.argv.slice(2).join(" ").trim();
if (!text) {
  console.error('usage: node notify.mjs "<message to teammate>"');
  process.exit(1);
}
const cfg = loadConfig(process.cwd());
const body = `🤖 ${cfg.dev}'s agent (\`${currentBranch(cfg.repoRoot)}\`): ${text}`;

const thread = conflictThreadFor(cfg, text);
if (thread && postToThread(cfg, thread.root, body)) {
  console.log(`[collab] posted into the ${thread.file} conflict thread (root ${thread.root})`);
} else {
  postMessage(cfg, body);
  console.log(`[collab] posted to #${cfg.channel}${cfg.dryRun ? " (dry-run mirror)" : ""}`);
}
