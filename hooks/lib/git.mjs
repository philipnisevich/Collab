// Thin git helpers used by hooks. Every call is failure-tolerant: hooks must
// never crash the dev's Claude Code session.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseUnifiedDiff } from "./overlap.mjs";

export function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function currentBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "detached";
}

export function repoRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
}

/**
 * Hunk ranges (new-file line numbers) for a single file's uncommitted changes.
 * Untracked files (fresh Write) don't appear in `git diff`, so treat the whole
 * file as one hunk.
 */
export function fileHunks(cwd, filePath) {
  const root = repoRoot(cwd);
  const rel = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
  const out = git(root, ["diff", "-U0", "HEAD", "--", rel]);
  const parsed = parseUnifiedDiff(out);
  if (parsed.length > 0) return { file: rel, hunks: parsed[0].hunks };

  // Untracked (or unborn HEAD): whole file counts as changed.
  const tracked = git(root, ["ls-files", "--", rel]);
  if (!tracked) {
    try {
      const abs = path.isAbsolute(filePath) ? filePath : path.join(root, rel);
      const lineCount = fs.readFileSync(abs, "utf8").split("\n").length;
      return { file: rel, hunks: [{ start: 1, end: Math.max(1, lineCount) }] };
    } catch {
      /* fall through */
    }
  }
  return { file: rel, hunks: [] };
}

/** One-line change summary for the Stop hook. */
export function changeSummary(cwd) {
  const root = repoRoot(cwd);
  const stat = git(root, ["diff", "--stat", "HEAD"]);
  const last = stat.split("\n").filter(Boolean).pop() || "no uncommitted changes";
  const files = git(root, ["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  return { summary: last.trim(), files };
}
