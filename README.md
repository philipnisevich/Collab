# Collab

**Two devs. One repo. Zero merge conflicts.** Each developer's Claude Code
connects to a shared [Kylon](https://kylon.io) workspace; their agents watch
each other's in-flight edits, warn about collisions *while code is being
written*, and coordinate in a Kylon channel everyone can read.

## How it works

```
 Laptop A (Dev A)                                Laptop B (Dev B)
 ┌───────────────────────────┐                  ┌───────────────────────────┐
 │ kylon gateway run          │                  │ kylon gateway run          │
 │   └─ Claude Code (agent-A) │                  │   └─ Claude Code (agent-B) │
 │      └─ Collab hooks ──────┼───┐          ┌───┼──── Collab hooks           │
 └───────────────────────────┘   │          │   └───────────────────────────┘
                                  ▼          ▼
                       ┌────────────────────────────┐
                       │  Kylon workspace (hosted)   │
                       │  ├─ #dev-sync channel       │ ← agents + humans coordinate
                       │  ├─ heartbeat state files   │ ← who's touching which lines
                       │  ├─ Activity Board + threads│ ← live status, per-conflict negotiation
                       │  └─ digest workflow         │ ← Kylon's own agent audits merge risk
                       └────────────────────────────┘
```

Four Claude Code hooks do the bridging:

| Hook | What it does |
|---|---|
| `SessionStart` | Announces your agent in `#dev-sync`, tells it who else is online |
| `UserPromptSubmit` | **Predicts the file set the prompt will touch** (explicit paths + `git grep`'d symbols), publishes it as the agent's planning heartbeat, intersects it with every teammate's predicted + active sets, and injects tiered warnings *before any code is written* |
| `PostToolUse` (Edit/Write) | Reports your changed hunks; on collision, warns the agent **mid-turn** and tells it to message the teammate |
| `Stop` | Posts a turn summary ("renamed getUser→fetchUser, 6 files") so the teammate's next prompt sees it |
| **Activity Board** | Live per-dev board message in `#dev-sync` — one line per file in flight with status 📝 planning / ✏️ editing / 🔴 CONFLICT and line ranges, updated in place on every heartbeat (this workspace retired table creation, so the board is a self-refreshing message) |
| **Conflict threads** | Each ⚠️ conflict alert in `#dev-sync` gets a Kylon **thread**; `notify.mjs` auto-routes agent updates that mention the conflicted file into that thread so the negotiation stays organized |
| **DM escalation** | ≥2 active collisions with the same teammate inside 10 min → the agent **DMs that teammate's human** ("your agents keep colliding in `<file>` — sync for 30s"), at most once per 10 min; DM address comes from `kylonUser` in `.collab.json`, advertised via the heartbeat |
| **Merge-risk digest** | A **Kylon workflow** (`scripts/setup-workflow.sh`) — Kylon's own internal agent reads the heartbeat files every 15 min and posts a digest ("2 files contested, 0 clear") to `#dev-sync`. Created paused; `workflow resume <id>` to arm it |
| **Gateway preflight** | `scripts/gateway-preflight.sh` — one command that detects the moment Kylon enables external agents on the workspace, then prints the `gateway run` command (see `docs/gateway.md`) |

Conflict detection is deterministic (no LLM latency) and tiered per the
[design doc](docs/design-doc.md):

1. **Overlap** — both agents' *predicted* file sets intersect (prompt time,
   before any edit)
2. **Active collision** — one agent plans to touch a file the other has
   uncommitted edits in
3. **Hunk collision** — `git diff -U0` ranges overlap ±10 lines (edit time)

Warnings are advisory and come with resolution options: (a) leave the file to
whoever's further along, (b) split the task, (c) proceed and accept the risk.

## Quickstart (offline, one machine — no Kylon account needed)

```bash
scripts/setup-demo.sh ~/collab-demo
# open Claude Code in ~/collab-demo-dev-a and ~/collab-demo-dev-b (two terminals)
# A: "Rename getUser to fetchUser across the codebase"
# B: "Add an in-memory cache to getUser"
# watch the agents detect the collision and negotiate
```

Dry-run mode transports everything through a shared `.collab/` directory —
same code paths, no network.

## Quickstart (Kylon mode, the real thing)

```bash
export KYLON_API_KEY=pak_...       # one agent key per developer
scripts/setup-kylon.sh             # auth, channel + table bootstrap
node hooks/install.mjs /path/to/your/repo
# in .collab.json: set "dev" to your name, "dryRun": false
kylon gateway run --server-url https://api.kylon.io --provider claude-code --api-key $KYLON_API_KEY
```

✅ **Live-verified 2026-07-16** against a real Kylon workspace: presence,
planning heartbeats, OVERLAP → ACTIVE COLLISION escalation, channel messages
with unread semantics — all end-to-end. CLI quirks discovered and handled
(documented in `hooks/lib/kylon.mjs`): `message send` requires the channel
**ID** (names 404), this build has no `history recent` / `--since` / `file
append`, and path-written files don't appear in `file list` (hence the roster
design). All remote calls fall back to the local mirror on failure.

⚠️ One remaining gate: `kylon gateway run` (prompting agents via @mention)
returns "External agents are only enabled in development" — ask Kylon to
enable external agents on the workspace. Not blocking: terminal-prompted
Claude Code with hooks is fully functional, which is the primary flow.

## Layout

```
hooks/            the four hooks + notify.mjs (agent→agent messaging) + install.mjs
hooks/lib/        overlap engine, git helpers, config, Kylon wrapper
demo-app/         tiny zero-dep user API — the collision playground
scripts/          setup-demo.sh (offline), setup-kylon.sh (live),
                  setup-workflow.sh (digest), gateway-preflight.sh
tests/            unit tests (npm test)
docs/             demo script, design doc, gateway notes, workflow.html
```

## Design principles

- **Warn, never block.** Prompts always run; agents get awareness, not handcuffs.
- **No custom server.** Kylon channels, workspace files, threads, and workflows replace the entire relay layer.
- **Hooks never crash a session.** Every hook catches everything and exits 0.
- **Honest injection points.** Claude Code can't be pushed mid-turn from outside,
  so teammate messages land at real seams: `PostToolUse` feedback during a turn,
  `UserPromptSubmit` at the next prompt.
