#!/usr/bin/env node
// Stop: when the agent finishes a turn, publish a change summary to
// #dev-sync so the teammate's next prompt sees what just landed.
import { loadConfig } from "./lib/config.mjs";
import { currentBranch, changeSummary } from "./lib/git.mjs";
import { postMessage, reportActivity } from "./lib/kylon.mjs";
import { readHookInput, safely } from "./lib/io.mjs";

await safely(async () => {
  const input = await readHookInput();
  if (input.stop_hook_active) process.exit(0); // don't loop

  const cfg = loadConfig(input.cwd);
  const branch = currentBranch(cfg.repoRoot);
  // Heartbeat: this agent is idle until the next prompt (§3b status field).
  reportActivity(cfg, [
    { ts: Date.now(), dev: cfg.dev, branch, file: null, kind: "presence", status: "idle" },
  ]);
  const { summary, files } = changeSummary(cfg.repoRoot);
  if (!files.length) process.exit(0);

  const fileList = files.slice(0, 8).join(", ") + (files.length > 8 ? ", …" : "");
  postMessage(cfg, `✅ ${cfg.dev}'s agent finished a turn on \`${branch}\` — ${summary} [${fileList}]`);
});
