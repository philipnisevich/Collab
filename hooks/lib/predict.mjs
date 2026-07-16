// §3a of the design doc: predict the file set a prompt will touch BEFORE any
// edit happens. MVP sources (deterministic, no model pass):
//   explicit   — files/paths literally named in the prompt
//   structural — identifier-like symbols in the prompt resolved to the files
//                that contain them (git grep)
import { execFileSync } from "node:child_process";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "then", "them",
  "should", "would", "could", "please", "make", "across", "codebase", "file",
  "files", "code", "function", "functions", "class", "method", "update",
  "change", "rename", "refactor", "implement", "create", "delete", "remove",
  "everywhere", "endpoint", "test", "tests", "cache", "memory", "inmemory",
]);

/** Identifier-like tokens worth resolving: camelCase, snake_case, dotted. */
export function extractTokens(prompt) {
  const raw = (prompt || "").match(/[A-Za-z_][A-Za-z0-9_.]{3,}/g) || [];
  const tokens = raw
    .map((t) => t.replace(/\.+$/, ""))
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t.toLowerCase()));
  // Prefer tokens that LOOK like code (mixed case, underscores, dots) —
  // plain lowercase words only count if nothing better exists.
  const codeish = tokens.filter((t) => /[A-Z_.]/.test(t.slice(1)) || /^[A-Z]/.test(t));
  const pool = codeish.length ? codeish : tokens;
  return [...new Set(pool)].sort((a, b) => b.length - a.length).slice(0, 8);
}

/** Repo paths whose path or basename is literally mentioned in the prompt. */
export function matchExplicit(prompt, repoFiles) {
  const p = (prompt || "").toLowerCase();
  const hits = [];
  for (const file of repoFiles) {
    const base = file.split("/").pop();
    const stem = base.replace(/\.[^.]+$/, "");
    if (p.includes(file.toLowerCase()) || (stem.length > 3 && p.includes(base.toLowerCase()))) {
      hits.push(file);
    }
  }
  return hits;
}

function git(cwd, args) {
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

/**
 * Predict the file set for a prompt.
 * @returns [{file, source: "explicit"|"structural", token?}]
 */
export function predictFileSet(repoRoot, prompt, { maxFilesPerToken = 10 } = {}) {
  const repoFiles = git(repoRoot, ["ls-files"]).split("\n").filter(Boolean);
  if (!repoFiles.length) return [];

  const results = new Map(); // file → {file, source, token}
  for (const f of matchExplicit(prompt, repoFiles)) {
    results.set(f, { file: f, source: "explicit" });
  }

  // Structural resolution only makes sense for source files — a README that
  // *mentions* a symbol isn't going to be edited by the task (§5: keep
  // precision high so warnings stay believable).
  const NON_SOURCE = /\.(md|markdown|txt|rst|json|lock|ya?ml|toml|csv|svg|png|jpg)$/i;
  for (const token of extractTokens(prompt)) {
    const out = git(repoRoot, ["grep", "-l", "--fixed-strings", token, "--", "."]);
    const files = out.split("\n").filter(Boolean).filter((f) => !NON_SOURCE.test(f));
    // A token matching many files is too generic to be a useful signal.
    if (!files.length || files.length > maxFilesPerToken) continue;
    for (const f of files) {
      if (!results.has(f)) results.set(f, { file: f, source: "structural", token });
    }
  }
  return [...results.values()];
}
