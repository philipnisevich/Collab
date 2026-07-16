#!/usr/bin/env node
// UserPromptSubmit — the §3 pipeline from the design doc, at the decision point:
//   1. predict the file set this prompt will touch (explicit + structural)
//   2. publish it as this agent's "planning" heartbeat
//   3. intersect against every teammate's predicted + actively-edited sets
//   4. surface tiered warnings inline BEFORE any code is written, plus one
//      deduped message to #dev-sync so a human can arbitrate
// Advisory, never blocking: the prompt always proceeds.
import { loadConfig } from "./lib/config.mjs";
import { currentBranch, changeSummary, fileHunks } from "./lib/git.mjs";
import {
  fetchTeammateActivity,
  fetchTeammateMessages,
  reportActivity,
  postMessage,
  shouldAnnounce,
  rememberPrediction,
} from "./lib/kylon.mjs";
import { detectOverlap, detectPromptConflicts, formatFindings, formatPromptConflicts, rowKind } from "./lib/overlap.mjs";
import { predictFileSet } from "./lib/predict.mjs";
import { readHookInput, emitContext, safely } from "./lib/io.mjs";

await safely(async () => {
  const input = await readHookInput();
  const cfg = loadConfig(input.cwd);
  const branch = currentBranch(cfg.repoRoot);
  const lines = [];

  // Every prompt is visible in Kylon: the team sees what each dev asked for,
  // in order — which is also what makes first-come priority auditable.
  if (input.prompt) {
    postMessage(cfg, `💬 prompted on \`${branch}\`: "${String(input.prompt).slice(0, 220)}"`);
  }

  // --- §3a predict + §3b publish ---
  // Vague follow-ups ("continue") keep the previous prediction in force.
  const predicted = rememberPrediction(cfg, predictFileSet(cfg.repoRoot, input.prompt));
  if (predicted.length) {
    reportActivity(
      cfg,
      predicted.map((p) => ({
        ts: Date.now(),
        dev: cfg.dev,
        branch,
        file: p.file,
        kind: "predicted",
        source: p.source,
        session: (input.session_id || "").slice(0, 8),
      }))
    );
  }

  // --- teammate state ---
  const theirs = fetchTeammateActivity(cfg);
  const fileRows = theirs.filter((r) => rowKind(r) !== "presence");

  if (fileRows.length) {
    const byDev = new Map();
    for (const r of fileRows) {
      const key = `${r.dev} (${r.branch || "?"})`;
      if (!byDev.has(key)) byDev.set(key, new Set());
      const tag = rowKind(r) === "predicted" ? "planned" : `${r.start}-${r.end}`;
      byDev.get(key).add(`${r.file}:${tag}`);
    }
    lines.push("[Collab] Teammate agents are currently working on:");
    for (const [dev, files] of byDev) lines.push(`- ${dev}: ${[...files].slice(0, 10).join(", ")}`);
  }

  // --- §3c prompt-time tier check (Overlap / Active collision) ---
  const promptConflicts = detectPromptConflicts(predicted, fileRows);
  const preEdit = formatPromptConflicts(promptConflicts);
  if (preEdit) {
    lines.push(preEdit);
    // One human-readable line to the channel per file pair, deduped (§4).
    for (const c of promptConflicts) {
      if (shouldAnnounce(cfg, `${c.tier}|${c.file}|${c.theirs?.dev}`)) {
        postMessage(
          cfg,
          `⚠️ ${c.tier === "active-collision" ? "Active collision" : "Overlap"}: ${cfg.dev}'s agent and ${c.theirs?.dev}'s agent both ${
            c.tier === "active-collision" ? "have work in" : "plan to edit"
          } \`${c.file}\``
        );
      }
    }
  }

  // --- pre-existing uncommitted collisions (hunk-level) ---
  const mine = changeSummary(cfg.repoRoot).files.map((f) => fileHunks(cfg.repoRoot, f));
  const activeRows = fileRows.filter((r) => rowKind(r) === "active");
  const findings = detectOverlap(mine.filter((m) => m.hunks.length), activeRows, { fuzz: cfg.fuzz });
  const warning = formatFindings(findings);
  if (warning) lines.push(warning);

  // --- unread teammate messages ---
  const msgs = fetchTeammateMessages(cfg, { limit: 8 });
  if (msgs.length) {
    lines.push(`[Collab] Recent #${cfg.channel} messages from teammates:`);
    for (const m of msgs) lines.push(`- ${m.dev}: ${String(m.text).slice(0, 300)}`);
  }

  if (lines.length) {
    lines.push(
      `To coordinate with your teammate's agent, run: node ${import.meta.dirname}/notify.mjs "<short, concrete message>". Adapt to teammate messages when they affect shared code.`
    );
  }
  emitContext("UserPromptSubmit", lines.join("\n"));
});
