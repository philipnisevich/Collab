// Overlap engine: parse `git diff -U0` output and detect collisions between
// this dev's edits and the teammate's reported activity rows.

/**
 * Parse unified diff text (ideally produced with -U0) into per-file hunk
 * ranges expressed in NEW-file line numbers.
 * @returns {{file: string, hunks: {start: number, end: number}[]}[]}
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let current = null;
  for (const line of (text || "").split("\n")) {
    if (line.startsWith("+++ ")) {
      let p = line.slice(4).trim();
      if (p.startsWith("b/")) p = p.slice(2);
      current = p === "/dev/null" ? null : { file: p, hunks: [] };
      if (current) files.push(current);
    } else if (line.startsWith("@@") && current) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = parseInt(m[1], 10);
      const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
      // count === 0 means a pure deletion anchored at `start`; keep a 1-line marker.
      const end = count === 0 ? start : start + count - 1;
      current.hunks.push({ start: Math.max(1, start), end: Math.max(1, end) });
    }
  }
  return files;
}

/** Inclusive range intersection with a fuzz margin on both sides. */
export function rangesOverlap(a, b, fuzz = 0) {
  return a.start <= b.end + fuzz && b.start <= a.end + fuzz;
}

/**
 * Compare my parsed changes against teammate activity rows.
 * @param {{file: string, hunks: {start,end}[]}[]} mine
 * @param {{dev, branch, file, start, end}[]} theirs
 * @returns findings: [{file, severity: "high"|"medium", mine?, theirs}]
 *   high   = hunk ranges collide (within fuzz lines)
 *   medium = same file touched, different regions
 */
export function detectOverlap(mine, theirs, { fuzz = 10 } = {}) {
  const findings = [];
  for (const m of mine) {
    const rows = theirs.filter((r) => r.file === m.file);
    if (rows.length === 0) continue;
    let hunkHit = false;
    for (const h of m.hunks) {
      for (const r of rows) {
        if (Number.isFinite(r.start) && Number.isFinite(r.end) && rangesOverlap(h, r, fuzz)) {
          findings.push({ file: m.file, severity: "high", mine: h, theirs: r });
          hunkHit = true;
        }
      }
    }
    if (!hunkHit) {
      findings.push({ file: m.file, severity: "medium", theirs: rows[0] });
    }
  }
  return findings;
}

/** Effective kind for an activity row (older rows predate the kind field). */
export function rowKind(r) {
  if (r.kind) return r.kind;
  if (!r.file) return "presence";
  return Number.isFinite(r.start) ? "active" : "predicted";
}

/**
 * §2 tier check at PROMPT time: my predicted file set vs teammates' state.
 * @param {{file, source}[]} predicted
 * @param {*} theirs activity rows
 * @returns [{tier: "active-collision"|"overlap", file, theirs, source}]
 *   active-collision — teammate has uncommitted edits in a file I plan to touch
 *   overlap          — both agents merely PLAN to touch the same file
 */
export function detectPromptConflicts(predicted, theirs) {
  const findings = [];
  for (const p of predicted) {
    const rows = theirs.filter((r) => r.file === p.file && rowKind(r) !== "presence");
    if (!rows.length) continue;
    const active = rows.find((r) => rowKind(r) === "active");
    if (active) {
      findings.push({ tier: "active-collision", file: p.file, theirs: active, source: p.source });
    } else {
      findings.push({ tier: "overlap", file: p.file, theirs: rows[0], source: p.source });
    }
  }
  return findings;
}

/**
 * Render prompt-time conflicts with the first-come priority rule: the
 * teammate's agent was already on these files when this prompt arrived, so
 * this agent yields on the conflicting parts and explains why to its user.
 */
export function formatPromptConflicts(findings) {
  if (!findings.length) return "";
  const who = findings[0].theirs?.dev
    ? `${findings[0].theirs.dev} (${findings[0].theirs.branch || "?"})`
    : "your teammate";
  const hasActive = findings.some((f) => f.tier === "active-collision");
  const lines = [`⚠️ PRE-EDIT CONFLICT CHECK — ${who}'s agent was FIRST on files your task needs:`];
  for (const f of findings.slice(0, 6)) {
    const w = f.theirs?.dev ? `${f.theirs.dev} (${f.theirs.branch || "?"})` : "teammate";
    lines.push(
      f.tier === "active-collision"
        ? `- ACTIVE COLLISION ${f.file}: ${w} is editing this file RIGHT NOW${
            Number.isFinite(f.theirs?.start) ? ` (lines ${f.theirs.start}-${f.theirs.end})` : ""
          }`
        : `- OVERLAP ${f.file}: ${w} also plans to touch this file`
    );
  }
  if (hasActive) {
    lines.push(
      "TEAMMATE PRIORITY RULE — they started first. Do NOT make changes that would break or conflict with their in-flight work. Instead:",
      "  1. Tell your user plainly which part of their request conflicts and why you are holding off on it (e.g. \"I can't rename getUser right now — " +
        who +
        "'s agent is mid-task inside it\").",
      "  2. Offer alternatives: do the non-conflicting parts now, adapt to the teammate's interface when they finish, or split the task.",
      "  3. Post your intent to the channel so both sides stay aligned.",
      "Only touch the conflicting files if your user explicitly insists — then say the merge risk out loud and proceed."
    );
  } else {
    lines.push(
      "Both agents merely PLAN to touch these files — coordinate before either writes code:",
      "  (a) leave the shared files to whoever is further along,",
      "  (b) split the task so the file sets no longer intersect,",
      "  (c) proceed anyway and accept the merge risk — say so explicitly."
    );
  }
  return lines.join("\n");
}

/** Render findings as a compact, injectable warning block. */
export function formatFindings(findings) {
  if (!findings.length) return "";
  const lines = ["⚠️ CONFLICT RISK with your teammate's in-flight work:"];
  for (const f of findings.slice(0, 8)) {
    const who = f.theirs?.dev ? `${f.theirs.dev} (${f.theirs.branch || "?"})` : "teammate";
    if (f.severity === "high") {
      lines.push(
        `- HIGH ${f.file}: your lines ${f.mine.start}-${f.mine.end} collide with ${who}'s lines ${f.theirs.start}-${f.theirs.end}`
      );
    } else {
      lines.push(`- MEDIUM ${f.file}: also being edited by ${who} (different region)`);
    }
  }
  return lines.join("\n");
}
