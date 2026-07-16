// ALL Kylon interaction lives in this file. Every remote call was verified
// against the real CLI on 2026-07-16 (workspace 7f179165eca8):
//
//   kylon workspace message send --channel <CHANNEL_ID> --text "..."   ✅ (~0.5s; channel NAME 404s — ID required)
//   kylon workspace history search "<q>" --channel <id> --since <iso>  ✅ (history recent: NOT in this build)
//   kylon workspace file write --path /workspace/shared/... --content  ✅ (~0.8s; file append: NOT in this build)
//   kylon workspace file read  --path /workspace/shared/...            ✅ (~0.4s)
//   kylon workspace file list  --directory ...                         ❌ does not see path-written files → roster instead
//   kylon workspace channel list --query <name>                        ✅ (used to resolve channel id once)
//
// State model (§3b of the design doc): each dev's agent owns ONE remote state
// file (full heartbeat, overwritten each report) plus a shared roster of dev
// names. Coordination messages go to the #dev-sync channel.
//
// Dry-run mode (no Kylon auth) uses the same state files in cfg.sharedDir —
// point two worktrees at one sharedDir for the offline demo.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REMOTE_BASE = "/workspace/shared/collab";
// Channel wire format: "[collab:dev] text". The constant "collab:" marker is
// what history search queries for (this CLI build has no --since flag).
const WIRE = /^\[collab:([^\]]+)\] (.*)$/;

const localStatePath = (cfg, dev) => path.join(cfg.sharedDir, `state-${dev}.json`);
const localRosterPath = (cfg) => path.join(cfg.sharedDir, "roster.json");
const messagesPath = (cfg) => path.join(cfg.sharedDir, "messages.jsonl");
const cachePath = (cfg) => path.join(cfg.sharedDir, `cache-${cfg.dev}.json`);
const errorsPath = (cfg) => path.join(cfg.sharedDir, "errors.log");

// ---------- plumbing ----------

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function kylonCli(cfg, args) {
  try {
    return execFileSync("kylon", args, {
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, ...(cfg.apiKey ? { KYLON_WORKSPACE_API_KEY: cfg.apiKey } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    try {
      appendJsonl(errorsPath(cfg), {
        ts: Date.now(),
        args: args.slice(0, 6),
        error: String(err?.stderr || err?.message || err).slice(0, 400),
      });
    } catch {
      /* never throw from a hook */
    }
    return null;
  }
}

function remoteRead(cfg, remotePath) {
  return kylonCli(cfg, ["workspace", "file", "read", "--path", remotePath]);
}

function remoteWrite(cfg, remotePath, content) {
  return kylonCli(cfg, ["workspace", "file", "write", "--path", remotePath, "--content", content]);
}

/** Resolve the #dev-sync channel id once; cache it locally. */
function channelId(cfg) {
  if (cfg.channelId) return cfg.channelId;
  const cacheFile = path.join(cfg.sharedDir, "channel-id.txt");
  try {
    const cached = fs.readFileSync(cacheFile, "utf8").trim();
    if (cached) return cached;
  } catch {
    /* resolve below */
  }
  const out = kylonCli(cfg, ["workspace", "channel", "list", "--query", cfg.channel]) || "";
  // format: "- c25f6c73c97c  #dev-sync  iconColor=green"
  const m = new RegExp(`^- ([0-9a-f]+)\\s+#${cfg.channel}\\b`, "m").exec(out);
  if (m) {
    try {
      fs.writeFileSync(cacheFile, m[1]);
    } catch {
      /* best-effort */
    }
    return m[1];
  }
  return null;
}

// ---------- messaging ----------

/** Post a message to #dev-sync (always mirrored locally for the dry-run/demo trail). */
export function postMessage(cfg, text) {
  appendJsonl(messagesPath(cfg), { ts: Date.now(), dev: cfg.dev, text });
  if (!cfg.dryRun) {
    const id = channelId(cfg);
    if (id) {
      kylonCli(cfg, ["workspace", "message", "send", "--channel", id, "--text", `[collab:${cfg.dev}] ${text}`]);
    }
  }
}

/** UNSEEN messages from OTHER devs, oldest→newest. */
export function fetchTeammateMessages(cfg, { limit = 10 } = {}) {
  if (!cfg.dryRun) {
    const id = channelId(cfg);
    if (id) {
      // VERIFIED signature in this build: history search <query> [--from] [--channel] [--limit]
      const out = kylonCli(cfg, [
        "workspace", "history", "search", "collab:", "--channel", id, "--limit", "30",
      ]);
      if (out != null) {
        const seenPath = path.join(cfg.sharedDir, `seen-${cfg.dev}.json`);
        const seen = readJson(seenPath, {});
        const msgs = [];
        let msgId = null;
        for (const line of out.split("\n")) {
          // "- 9364a07c43c0 [dev-sync] replies=0 matches=root"
          const idm = /^- ([0-9a-f]+) \[/.exec(line);
          if (idm) {
            msgId = idm[1];
            continue;
          }
          // "  root (matched): [collab:dev-b] 🤖 ..."
          const m = /^\s+root(?: \(matched\))?:\s+(.*)$/.exec(line);
          if (!m || !msgId || seen[msgId]) continue;
          const w = WIRE.exec(m[1]);
          if (w && w[1] !== cfg.dev) {
            msgs.push({ id: msgId, dev: w[1], text: w[2] });
            seen[msgId] = Date.now();
          }
        }
        try {
          fs.writeFileSync(seenPath, JSON.stringify(seen));
        } catch {
          /* best-effort */
        }
        return msgs.reverse().slice(-limit); // search returns newest first
      }
    }
    // fall through to local mirror on any failure — never kill the session
  }
  return readLocalMessages(cfg, limit);
}

function readLocalMessages(cfg, limit) {
  try {
    return fs
      .readFileSync(messagesPath(cfg), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => readJsonSafe(l))
      .filter((m) => m && m.dev !== cfg.dev)
      .slice(-limit);
  } catch {
    return [];
  }
}

function readJsonSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------- heartbeat state (§3b) ----------

function loadMyState(cfg) {
  return readJson(localStatePath(cfg, cfg.dev), {
    dev: cfg.dev,
    branch: null,
    status: "online",
    predicted: [],
    active: [],
    ts: 0,
  });
}

/**
 * Merge activity rows into my heartbeat and publish it (one remote call).
 * Row kinds: presence (status change), predicted (replaces predicted set),
 * active (upsert per file+range).
 */
export function reportActivity(cfg, rows) {
  const state = loadMyState(cfg);
  const predictedBatch = [];
  for (const row of rows) {
    if (row.branch) state.branch = row.branch;
    if (!row.file) {
      if (row.status) state.status = row.status;
    } else if (row.kind === "predicted") {
      predictedBatch.push({ file: row.file, source: row.source });
    } else {
      state.status = "editing";
      const key = `${row.file}|${row.start}-${row.end}`;
      state.active = state.active.filter((a) => `${a.file}|${a.start}-${a.end}` !== key);
      state.active.push({ file: row.file, start: row.start, end: row.end, ts: row.ts });
    }
  }
  if (predictedBatch.length) {
    state.predicted = predictedBatch;
    if (state.status !== "editing") state.status = "planning";
  }
  const cutoff = Date.now() - cfg.activityWindowMs;
  state.active = state.active.filter((a) => (a.ts ?? 0) >= cutoff);
  state.ts = Date.now();

  const json = JSON.stringify(state);
  try {
    fs.writeFileSync(localStatePath(cfg, cfg.dev), json);
  } catch {
    /* best-effort */
  }
  mergeRoster(cfg, false);
  if (!cfg.dryRun) remoteWrite(cfg, `${REMOTE_BASE}/state-${cfg.dev}.json`, json);
}

/** Keep the shared roster containing my dev name (self-healing, throttled). */
function mergeRoster(cfg, force) {
  const local = readJson(localRosterPath(cfg), { devs: {} });
  const needsLocal = !local.devs[cfg.dev];
  local.devs[cfg.dev] = Date.now();
  try {
    fs.writeFileSync(localRosterPath(cfg), JSON.stringify(local));
  } catch {
    /* best-effort */
  }
  if (cfg.dryRun) return;
  if (!needsLocal && !force) return; // remote roster refreshed only when needed
  const remote = readJsonSafe(remoteRead(cfg, `${REMOTE_BASE}/roster.json`) || "") || { devs: {} };
  remote.devs = { ...remote.devs, ...local.devs, [cfg.dev]: Date.now() };
  remoteWrite(cfg, `${REMOTE_BASE}/roster.json`, JSON.stringify(remote));
}

/**
 * Teammate heartbeats flattened into activity rows for the overlap engine,
 * cached cfg.cacheTtlMs to bound hook latency.
 */
export function fetchTeammateActivity(cfg) {
  const cached = readJson(cachePath(cfg), null);
  if (cached && Date.now() - cached.ts < cfg.cacheTtlMs) return cached.rows;

  let states = [];
  if (cfg.dryRun) {
    const roster = readJson(localRosterPath(cfg), { devs: {} });
    for (const dev of Object.keys(roster.devs)) {
      if (dev === cfg.dev) continue;
      const s = readJson(localStatePath(cfg, dev), null);
      if (s) states.push(s);
    }
  } else {
    let roster = readJsonSafe(remoteRead(cfg, `${REMOTE_BASE}/roster.json`) || "");
    if (!roster?.devs?.[cfg.dev]) {
      mergeRoster(cfg, true); // heal the roster if we're missing from it
      roster = roster?.devs ? roster : { devs: {} };
    }
    for (const dev of Object.keys(roster?.devs || {})) {
      if (dev === cfg.dev) continue;
      const s = readJsonSafe(remoteRead(cfg, `${REMOTE_BASE}/state-${dev}.json`) || "");
      if (s) states.push(s);
    }
  }

  const cutoff = Date.now() - cfg.activityWindowMs;
  const rows = [];
  for (const s of states) {
    if ((s.ts ?? 0) < cutoff) continue; // whole heartbeat is stale
    rows.push({ dev: s.dev, branch: s.branch, file: null, kind: "presence", status: s.status, ts: s.ts });
    for (const p of s.predicted || []) {
      rows.push({ dev: s.dev, branch: s.branch, file: p.file, kind: "predicted", source: p.source, ts: s.ts });
    }
    for (const a of s.active || []) {
      if ((a.ts ?? s.ts) < cutoff) continue;
      rows.push({ dev: s.dev, branch: s.branch, file: a.file, kind: "active", start: a.start, end: a.end, ts: a.ts ?? s.ts });
    }
  }
  try {
    fs.writeFileSync(cachePath(cfg), JSON.stringify({ ts: Date.now(), rows }));
  } catch {
    /* best-effort */
  }
  return rows;
}

// ---------- prediction memory + announce dedupe (unchanged) ----------

/**
 * Persist/recall this agent's own predicted file set. Follow-up prompts are
 * often vague ("continue") and predict nothing — the task (and its file set)
 * hasn't changed, so the last prediction stays in force (§3b heartbeat).
 */
export function rememberPrediction(cfg, predicted) {
  const p = path.join(cfg.sharedDir, `predicted-${cfg.dev}.json`);
  if (predicted.length) {
    try {
      fs.writeFileSync(p, JSON.stringify({ ts: Date.now(), predicted }));
    } catch {
      /* best-effort */
    }
    return predicted;
  }
  const saved = readJson(p, null);
  if (saved && Date.now() - saved.ts < cfg.activityWindowMs) return saved.predicted;
  return predicted;
}

/**
 * Once-per-TTL guard for channel announcements so repeated prompts don't spam
 * #dev-sync with the same overlap warning.
 */
export function shouldAnnounce(cfg, key, ttlMs = 10 * 60_000) {
  const p = path.join(cfg.sharedDir, `announced-${cfg.dev}.json`);
  const seen = readJson(p, {});
  const now = Date.now();
  if (seen[key] && now - seen[key] < ttlMs) return false;
  seen[key] = now;
  for (const k of Object.keys(seen)) if (now - seen[k] > ttlMs) delete seen[k];
  try {
    fs.writeFileSync(p, JSON.stringify(seen));
  } catch {
    /* best-effort */
  }
  return true;
}
