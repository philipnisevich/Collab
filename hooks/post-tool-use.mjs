#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): after every file edit, report the
// touched hunks to the shared activity table and — if they collide with the
// teammate's in-flight work — warn the agent MID-TURN and tell it to
// coordinate. This is the "agents talking during a live prompt" moment.
import path from "node:path";
import { loadConfig } from "./lib/config.mjs";
import { currentBranch, fileHunks } from "./lib/git.mjs";
import { reportActivity, fetchTeammateActivity, markConflict, recordCollision, escalateDm } from "./lib/kylon.mjs";
import { detectOverlap, formatFindings } from "./lib/overlap.mjs";
import { readHookInput, emitContext, safely } from "./lib/io.mjs";

await safely(async () => {
  const input = await readHookInput();
  const filePath = input.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const cfg = loadConfig(input.cwd);
  // Ignore edits outside the repo or to collab plumbing itself.
  const rel = path.relative(cfg.repoRoot, path.resolve(input.cwd || cfg.repoRoot, filePath));
  if (rel.startsWith("..") || rel.startsWith(".collab") || rel.startsWith(".claude")) process.exit(0);

  const branch = currentBranch(cfg.repoRoot);
  const change = fileHunks(cfg.repoRoot, filePath);
  if (!change.hunks.length) process.exit(0);

  // Detect collisions BEFORE publishing so the Activity Board syncs once,
  // already showing 🔴 conflict on the colliding file.
  const theirs = fetchTeammateActivity(cfg).filter((r) => r.file);
  const findings = detectOverlap([change], theirs, { fuzz: cfg.fuzz });
  const high = findings.filter((f) => f.severity === "high");
  markConflict(cfg, high.map((f) => f.file));

  reportActivity(
    cfg,
    change.hunks.map((h) => ({
      ts: Date.now(),
      dev: cfg.dev,
      branch,
      file: change.file,
      kind: "active",
      start: h.start,
      end: h.end,
      session: (input.session_id || "").slice(0, 8),
    }))
  );

  // Repeated hunk-level collisions with the same teammate → DM their human.
  const escalated = [];
  for (const f of high) {
    if (recordCollision(cfg, f.theirs?.dev)) {
      escalateDm(cfg, f.theirs.dev, f.theirs.kylonUser, f.file);
      escalated.push(f.theirs.dev);
    }
  }

  const warning = formatFindings(findings);
  if (warning) {
    emitContext(
      "PostToolUse",
      warning +
        (escalated.length ? `\n[Collab] Repeated collisions — ${escalated.join(", ")}'s human was DM'd to sync up.` : "") +
        `\nNotify your teammate's agent NOW so they can adapt: run\n` +
        `node ${import.meta.dirname}/notify.mjs "<file, lines, and what you changed>"\n` +
        `Then continue, preferring changes that minimize the collision (e.g. adapt to their rename/interface instead of fighting it).`
    );
  }
});
