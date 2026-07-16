// ALL Kylon interaction lives in this file. Every remote call was verified
// against the real CLI on 2026-07-16 (workspace 7f179165eca8):
//
//   kylon workspace message send --channel <CHANNEL_ID> --text "..."   ✅ (~0.5s; channel NAME 404s — ID required)
//     → stdout "Sent message (id: 351be3989e7b)"; multi-line --text works
//   kylon workspace message delete --message <id> --scope-channel <ch> ✅ → "Deleted message <id>"
//   kylon workspace history search "<q>" --channel <id> --since <iso>  ✅ (history recent: NOT in this build)
//   kylon workspace file write --path /workspace/shared/... --content  ✅ (~0.8s; file append: NOT in this build)
//   kylon workspace file read  --path /workspace/shared/...            ✅ (~0.4s)
//   kylon workspace file list  --directory ...                         ❌ does not see path-written files → roster instead
//   kylon workspace channel list --query <name>                        ✅ (used to resolve channel id once)
//   kylon workspace thread create --target message:<id> --text "..." --scope-channel <ch>
//     ✅ → "Targeting thread on message:<id>\nPosted reply (id: <hex>)"; for
//     message targets the alert message itself IS the thread root.
//   kylon workspace thread msg --root <root_id> --text "..." --scope-channel <ch>
//     ✅ → "Posted thread reply under <root_id> (id: <hex>)"
//   kylon workspace message dm --to <display-name-or-user_id> --text   ✅ resolves display
//     names case-insensitively; unknown name → exit 2 "Could not resolve user"
//   kylon workspace table apply --spec '<json>'                        ❌ "Unknown table command: apply" (help lies)
//   kylon workspace table create ... --scope-channel <ch>              ❌ server 410 "Table creation has been retired.
//     Create a database app for new structured data" — and `app template pull` is
//     also not in this build, so NO table can be created in this workspace.
//     The Activity Board therefore renders as a single [collab-board:<dev>]
//     channel message maintained in place via delete+re-send (message ui update
//     is "only available in the internal workspace_cli tool"). Verified that
//     history search "collab:" does NOT match "[collab-board:...]" messages, so
//     the board never leaks into fetchTeammateMessages.
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
const boardPath = (cfg) => path.join(cfg.sharedDir, `board-${cfg.dev}.json`);
const conflictsPath = (cfg) => path.join(cfg.sharedDir, `conflicts-${cfg.dev}.json`);
const threadsPath = (cfg) => path.join(cfg.sharedDir, "threads.json");
const collisionsPath = (cfg) => path.join(cfg.sharedDir, `collisions-${cfg.dev}.json`);

/** Flagged-conflict marks and open conflict threads expire after this. */
const CONFLICT_TTL_MS = 10 * 60_000;
const THREAD_TTL_MS = 30 * 60_000;

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

function writeJsonSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch {
    /* best-effort — hooks never throw */
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

/** Parse "Sent message (id: 351be3989e7b)" — verified `message send` stdout. */
export function parseSentMessageId(out) {
  const m = /Sent message \(id: ([0-9a-f]+)\)/.exec(out || "");
  return m ? m[1] : null;
}

/**
 * Post a message to #dev-sync (always mirrored locally for the dry-run/demo
 * trail). Returns the sent message id in live mode, null otherwise.
 */
export function postMessage(cfg, text) {
  appendJsonl(messagesPath(cfg), { ts: Date.now(), dev: cfg.dev, text });
  if (!cfg.dryRun) {
    const id = channelId(cfg);
    if (id) {
      const out = kylonCli(cfg, ["workspace", "message", "send", "--channel", id, "--text", `[collab:${cfg.dev}] ${text}`]);
      return parseSentMessageId(out);
    }
  }
  return null;
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
  // Advertise how to DM this dev's human (feature: DM escalation addressing).
  if (cfg.kylonUser) state.kylonUser = cfg.kylonUser;

  const json = JSON.stringify(state);
  try {
    fs.writeFileSync(localStatePath(cfg, cfg.dev), json);
  } catch {
    /* best-effort */
  }
  mergeRoster(cfg, false);
  if (!cfg.dryRun) {
    remoteWrite(cfg, `${REMOTE_BASE}/state-${cfg.dev}.json`, json);
    syncBoard(cfg, state); // live-mode only: keep the Activity Board current
  }
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
    const ku = s.kylonUser || null; // teammate's human's Kylon address, for DM escalation
    rows.push({ dev: s.dev, branch: s.branch, file: null, kind: "presence", status: s.status, ts: s.ts, kylonUser: ku });
    for (const p of s.predicted || []) {
      rows.push({ dev: s.dev, branch: s.branch, file: p.file, kind: "predicted", source: p.source, ts: s.ts, kylonUser: ku });
    }
    for (const a of s.active || []) {
      if ((a.ts ?? s.ts) < cutoff) continue;
      rows.push({ dev: s.dev, branch: s.branch, file: a.file, kind: "active", start: a.start, end: a.end, ts: a.ts ?? s.ts, kylonUser: ku });
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

// ---------- Activity Board (feature 1) ----------
//
// One live board per dev in #dev-sync: a single "[collab-board:<dev>]" message
// listing every file this dev's agent is on, with status planning/editing/
// CONFLICT and line ranges. Kept current in place via delete + re-send (this
// workspace retired table creation — see header). No-change renders are
// skipped entirely, so a quiet hook costs zero extra CLI calls.

/**
 * Pure renderer: heartbeat state + conflict marks → board message text.
 * One line per file; conflict marks (file → ts) override status while fresh.
 * Deterministic (sorted) so identical activity renders identical text.
 */
export function renderBoard(state, conflicts = {}, now = Date.now(), ttlMs = CONFLICT_TTL_MS) {
  const rows = new Map(); // file → {status, lines}
  const ranges = new Map();
  for (const a of state.active || []) {
    if (!ranges.has(a.file)) ranges.set(a.file, []);
    ranges.get(a.file).push(`${a.start}-${a.end}`);
  }
  for (const [file, r] of ranges) rows.set(file, { status: "editing", lines: r.join(", ") });
  for (const p of state.predicted || []) {
    if (!rows.has(p.file)) rows.set(p.file, { status: "planning", lines: "" });
  }
  for (const [file, ts] of Object.entries(conflicts)) {
    if (now - ts < ttlMs && rows.has(file)) rows.get(file).status = "conflict";
  }
  const icon = { planning: "📝", editing: "✏️", conflict: "🔴" };
  const lines = [
    `[collab-board:${state.dev}] 📋 Activity Board — ${state.dev} on \`${state.branch || "?"}\` (${state.status || "online"})`,
  ];
  for (const file of [...rows.keys()].sort()) {
    const r = rows.get(file);
    lines.push(
      `${icon[r.status]} ${file} — ${r.status === "conflict" ? "CONFLICT" : r.status}${r.lines ? ` (lines ${r.lines})` : ""}`
    );
  }
  if (rows.size === 0) lines.push("(no files in flight)");
  return lines.join("\n");
}

/**
 * Flag files as conflicted on this dev's board (marks expire after TTL).
 * Call BEFORE reportActivity so the board syncs once with the right status.
 */
export function markConflict(cfg, files) {
  if (!files?.length) return;
  const now = Date.now();
  const marks = readJson(conflictsPath(cfg), {});
  for (const k of Object.keys(marks)) if (now - marks[k] > CONFLICT_TTL_MS) delete marks[k];
  for (const f of files) marks[f] = now;
  writeJsonSafe(conflictsPath(cfg), marks);
}

/** Re-publish this dev's board message iff its rendered text changed. */
function syncBoard(cfg, state) {
  const text = renderBoard(state, readJson(conflictsPath(cfg), {}));
  const prev = readJson(boardPath(cfg), {});
  if (prev.text === text) return; // throttle: no-change → no CLI calls
  const chan = channelId(cfg);
  if (!chan) return;
  if (prev.msgId) {
    kylonCli(cfg, ["workspace", "message", "delete", "--message", prev.msgId, "--scope-channel", chan]);
  }
  const out = kylonCli(cfg, ["workspace", "message", "send", "--channel", chan, "--text", text]);
  const msgId = parseSentMessageId(out);
  // On send failure keep text unset so the next report retries the publish.
  writeJsonSafe(boardPath(cfg), msgId ? { msgId, text, ts: Date.now() } : { msgId: null, ts: Date.now() });
}

// ---------- conflict threads (feature 2) ----------

/**
 * Open a Kylon thread on a just-posted conflict alert so the negotiation is
 * organized under it, and record file → thread-root both locally and in the
 * shared remote map so the TEAMMATE's notify.mjs finds it too.
 * For message targets the alert message id IS the thread root (verified).
 */
export function openConflictThread(cfg, file, alertMsgId, context) {
  if (!alertMsgId || cfg.dryRun) return null;
  const chan = channelId(cfg);
  if (!chan) return null;
  const out = kylonCli(cfg, [
    "workspace", "thread", "create", "--target", `message:${alertMsgId}`, "--text", context, "--scope-channel", chan,
  ]);
  if (out == null) return null;
  const map = readJson(threadsPath(cfg), {});
  map[file] = { root: alertMsgId, ts: Date.now() };
  writeJsonSafe(threadsPath(cfg), map);
  const remote = readJsonSafe(remoteRead(cfg, `${REMOTE_BASE}/threads.json`) || "") || {};
  remoteWrite(cfg, `${REMOTE_BASE}/threads.json`, JSON.stringify({ ...remote, ...map }));
  return alertMsgId;
}

/**
 * Pure matcher: does this outgoing message mention a file with a fresh open
 * conflict thread? Longest path match wins; basenames match too.
 */
export function matchThreadFile(map, text, now = Date.now(), ttlMs = THREAD_TTL_MS) {
  let best = null;
  for (const [file, entry] of Object.entries(map || {})) {
    if (!entry?.root || now - (entry.ts || 0) > ttlMs) continue;
    const base = file.split("/").pop();
    if (text.includes(file) || (base && text.includes(base))) {
      if (!best || file.length > best.file.length) best = { file, root: entry.root };
    }
  }
  return best;
}

/** Find an open conflict thread for a message, checking the shared remote map on miss. */
export function conflictThreadFor(cfg, text) {
  let map = readJson(threadsPath(cfg), {});
  let hit = matchThreadFile(map, text);
  if (!hit && !cfg.dryRun) {
    const remote = readJsonSafe(remoteRead(cfg, `${REMOTE_BASE}/threads.json`) || "");
    if (remote) {
      map = { ...remote, ...map };
      writeJsonSafe(threadsPath(cfg), map);
      hit = matchThreadFile(map, text);
    }
  }
  return hit;
}

/** Post into an open conflict thread. Returns true on success (caller falls back to postMessage). */
export function postToThread(cfg, root, text) {
  if (cfg.dryRun) return false; // dry-run has no real threads — channel mirror instead
  const chan = channelId(cfg);
  if (!chan) return false;
  const out = kylonCli(cfg, [
    "workspace", "thread", "msg", "--root", root, "--text", `[collab:${cfg.dev}] ${text}`, "--scope-channel", chan,
  ]);
  if (out == null) return false;
  appendJsonl(messagesPath(cfg), { ts: Date.now(), dev: cfg.dev, text, thread: root });
  return true;
}

// ---------- DM escalation (feature 3) ----------

/** Pure: escalate when >= min collision events landed inside the window and we haven't escalated within it. */
export function shouldEscalate(events, now = Date.now(), { min = 2, windowMs = CONFLICT_TTL_MS, lastEscalatedAt = 0 } = {}) {
  const recent = (events || []).filter((t) => now - t <= windowMs);
  return recent.length >= min && now - lastEscalatedAt > windowMs;
}

/**
 * Record one ACTIVE-COLLISION event against a teammate. Returns true when it's
 * time to DM their human (>= 2 events / 10 min, at most one DM per 10 min).
 */
export function recordCollision(cfg, teammateDev) {
  if (!teammateDev) return false;
  const now = Date.now();
  const data = readJson(collisionsPath(cfg), {});
  const entry = data[teammateDev] || { events: [], escalatedAt: 0 };
  entry.events = entry.events.filter((t) => now - t <= CONFLICT_TTL_MS);
  entry.events.push(now);
  const escalate = shouldEscalate(entry.events, now, { lastEscalatedAt: entry.escalatedAt });
  if (escalate) entry.escalatedAt = now;
  data[teammateDev] = entry;
  writeJsonSafe(collisionsPath(cfg), data);
  return escalate;
}

/**
 * DM the teammate's HUMAN. Addressing: their heartbeat's kylonUser (display
 * name or user_… id, from .collab.json) when present, else the dev name.
 * Verified: `message dm --to <name-or-id> --text` resolves display names;
 * a failed resolve exits 2 and lands in errors.log — never breaks the hook.
 */
export function escalateDm(cfg, teammateDev, kylonUser, file) {
  const to = kylonUser || teammateDev;
  const text = `⚠️ Your agent and ${cfg.dev}'s agent keep colliding in ${file} — you two should sync for 30 seconds.`;
  appendJsonl(messagesPath(cfg), { ts: Date.now(), dev: cfg.dev, dm: to, text });
  if (!cfg.dryRun) kylonCli(cfg, ["workspace", "message", "dm", "--to", to, "--text", text]);
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
