#!/usr/bin/env node
// Install Collab hooks into a target repo's .claude/settings.json.
//   node hooks/install.mjs /path/to/repo
// Merges with existing settings; embeds absolute paths to these hook scripts.
import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] || process.cwd());
if (!fs.existsSync(path.join(target, ".git"))) {
  console.error(`error: ${target} is not a git repo root`);
  process.exit(1);
}

const hooksDir = import.meta.dirname;
const cmd = (script) => `node "${path.join(hooksDir, script)}"`;

const entries = {
  SessionStart: [{ hooks: [{ type: "command", command: cmd("session-start.mjs") }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd("user-prompt-submit.mjs") }] }],
  PostToolUse: [
    {
      matcher: "Edit|Write|MultiEdit",
      hooks: [{ type: "command", command: cmd("post-tool-use.mjs") }],
    },
  ],
  Stop: [{ hooks: [{ type: "command", command: cmd("stop.mjs") }] }],
};

const settingsPath = path.join(target, ".claude", "settings.json");
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch {
  /* fresh settings */
}
settings.hooks ??= {};
for (const [event, groups] of Object.entries(entries)) {
  settings.hooks[event] ??= [];
  const already = JSON.stringify(settings.hooks[event]).includes(hooksDir);
  if (!already) settings.hooks[event].push(...groups);
}
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

// Make sure collab runtime files never get committed.
const gi = path.join(target, ".gitignore");
const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
if (!existing.includes(".collab/")) fs.appendFileSync(gi, (existing.endsWith("\n") || !existing ? "" : "\n") + ".collab/\n");

// Drop a config template if none exists.
const cfgPath = path.join(target, ".collab.json");
if (!fs.existsSync(cfgPath)) {
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      { dev: "CHANGE_ME", channel: "dev-sync", channelId: null, dryRun: true },
      null,
      2
    ) + "\n"
  );
}

console.log(`[collab] hooks installed into ${settingsPath}`);
console.log(`[collab] edit ${cfgPath} — set your dev name (and drop dryRun once Kylon is wired).`);
