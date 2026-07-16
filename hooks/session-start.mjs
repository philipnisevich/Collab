#!/usr/bin/env node
// SessionStart: announce presence in #dev-sync and register an activity row,
// then tell the agent who else is online.
import { loadConfig } from "./lib/config.mjs";
import { currentBranch } from "./lib/git.mjs";
import { postMessage, reportActivity, fetchTeammateActivity } from "./lib/kylon.mjs";
import { readHookInput, emitContext, safely } from "./lib/io.mjs";

await safely(async () => {
  const input = await readHookInput();
  const cfg = loadConfig(input.cwd);
  const branch = currentBranch(cfg.repoRoot);

  reportActivity(cfg, [
    { ts: Date.now(), dev: cfg.dev, branch, file: null, kind: "presence", status: "online" },
  ]);
  postMessage(cfg, `🟢 ${cfg.dev}'s agent is online on branch \`${branch}\``);

  const teammates = fetchTeammateActivity(cfg);
  const present = [
    ...new Set(
      teammates
        .filter((r) => !r.file && r.status !== "idle")
        .map((r) => `${r.dev} (${r.branch})`)
    ),
  ];

  const lines = [
    `[Collab] You are ${cfg.dev}'s coding agent on branch \`${branch}\`, coordinating with teammates through the Kylon "#${cfg.channel}" channel.`,
    present.length
      ? `Teammates online: ${present.join(", ")}.`
      : "No teammate agents online yet.",
    `When a conflict warning appears, coordinate BEFORE editing: run \`node ${import.meta.dirname}/notify.mjs "<message to teammate>"\` to post to #${cfg.channel}.`,
  ];
  emitContext("SessionStart", lines.join("\n"));
});
