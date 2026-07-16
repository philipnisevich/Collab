// Config resolution for Collab hooks.
// Precedence: env vars > .collab.json (at repo root) > defaults.
// If no KYLON_API_KEY is available, we run in DRY-RUN mode: all Kylon traffic
// is mirrored to a shared local directory instead, which doubles as the
// offline/single-machine demo transport (point COLLAB_SHARED_DIR of two
// worktrees at the same folder).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findRepoRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(cwd) {
  const root = findRepoRoot(cwd) || path.resolve(cwd || process.cwd());
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(root, ".collab.json"), "utf8"));
  } catch {
    /* no file config */
  }

  // Kylon docs use KYLON_WORKSPACE_API_KEY for workspace ops; accept both.
  const apiKey =
    process.env.KYLON_API_KEY || process.env.KYLON_WORKSPACE_API_KEY || fileCfg.apiKey || null;
  // A saved `kylon auth login` session works for all workspace commands, so
  // live mode doesn't strictly need a pak_ key.
  const hasCliAuth = fs.existsSync(path.join(os.homedir(), ".kylon", "workspace-auth.json"));
  const dryRunFlag = process.env.COLLAB_DRY_RUN;
  const dryRun =
    dryRunFlag != null
      ? dryRunFlag !== "0" && dryRunFlag !== "false"
      : fileCfg.dryRun ?? !(apiKey || hasCliAuth);

  const cfg = {
    dev: process.env.COLLAB_DEV || fileCfg.dev || os.userInfo().username,
    // This dev's HUMAN in Kylon (display name or user_… id) — how teammates'
    // agents DM them on repeated collisions. Advertised via the heartbeat.
    kylonUser: process.env.COLLAB_KYLON_USER || fileCfg.kylonUser || null,
    channel: process.env.COLLAB_CHANNEL || fileCfg.channel || "dev-sync",
    channelId: process.env.COLLAB_CHANNEL_ID || fileCfg.channelId || null,
    apiKey,
    dryRun,
    sharedDir: process.env.COLLAB_SHARED_DIR || fileCfg.sharedDir || path.join(root, ".collab"),
    fuzz: Number(process.env.COLLAB_FUZZ || fileCfg.fuzz || 10),
    cacheTtlMs: 5_000,
    // Activity rows older than this are ignored as stale.
    activityWindowMs: 30 * 60_000,
    repoRoot: root,
  };
  fs.mkdirSync(cfg.sharedDir, { recursive: true });
  return cfg;
}
