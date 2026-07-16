# Conflict Detection — Design Doc

**Product:** Real-time coordination layer for Claude Code
**Owner:** Philip Nisevich
**Status:** Draft v1
**Goal:** Detect when two AI coding agents are about to touch the same files and surface the conflict before either writes code, so teammates divide work cleanly instead of hitting a painful late-stage merge.

## 1. The problem, precisely

At a hackathon, N developers each run a Claude Code agent in parallel. Each agent takes a prompt and starts editing files on its own branch. Nothing tells agent B that agent A is already 40 lines into `auth/session.ts`. The collision only becomes visible at merge time — the most expensive possible moment to discover it.

The insight: **the collision is predictable at prompt time.** When a developer issues a prompt, we can estimate which files that work will touch before a single line is written, and check that estimate against what every other active agent is already touching.

## 2. What "conflict" means here

Three tiers, cheapest signal to strongest:

| Tier | Signal | Confidence | Cost |
|---|---|---|---|
| Overlap | Two agents' predicted file sets intersect | Medium | Cheap — runs at prompt time |
| Active collision | An agent is editing a file another agent has open/uncommitted | High | Cheap — from live agent state |
| Merge conflict | Two branches changed the same hunk | Certain | Late — this is what we're trying to prevent |

The product's whole value is moving detection **up** the table — catch Overlap before it becomes an Active collision, and Active before it becomes a Merge conflict.

## 3. How detection works

### 3a. Predict the file set (prompt time)

When an agent receives a prompt, before it edits, produce a **predicted file set** — the files this task will likely touch. Sources, in order of reliability:

1. **Explicit** — files named in the prompt or already open in the agent's context.
2. **Structural** — resolve symbols/imports the prompt references to their defining files (e.g. "add rate limiting to the login endpoint" → the file that defines that endpoint + its middleware).
3. **Heuristic** — a cheap model pass that maps the intent to a ranked file list from the repo tree.

Emit the set with a confidence score. Low confidence just means a wider net and a softer warning.

### 3b. Track live agent state

Each connected agent reports a lightweight heartbeat to the shared workspace:

- agent id / developer
- current branch
- predicted file set (from 3a)
- files with actual uncommitted edits
- status (planning / editing / idle)

This is the real-time index. It lives in the coordination layer, not in any one repo.

### 3c. Check on every prompt

When agent B's predicted set arrives, intersect it against every other active agent's predicted + actively-edited sets. Any non-empty intersection is a candidate conflict, ranked by tier (§2) and by how much the sets overlap.

## 4. How the signal surfaces (before code is written)

Detection is worthless if the warning lands after the edit. The signal has to interrupt at the decision point:

- **To the agent, inline:** before agent B starts editing, it receives "agent A (Dana) is actively editing auth/session.ts, which your task will touch. Coordinate before proceeding." The agent can pause, pick a different slice, or ask its developer.
- **To the shared channel:** a single message in the coordination channel — "Overlap: Philip's agent and Dana's agent both plan to edit auth/session.ts." — so a human can arbitrate in seconds.
- **Resolution options offered with the warning:** (a) reassign the file to whoever's further along, (b) split the task so the sets don't intersect, (c) proceed anyway and accept the merge risk (logged).

The default posture is **advisory, not blocking** — surface early, let humans/agents decide. Hard blocks come later and only for Active collisions on the same hunk.

## 5. Open questions (decide before building)

1. **Prediction accuracy floor.** How wrong can the predicted file set be before warnings become noise developers ignore? Need a target precision/recall and a way to measure it against real runs.
2. **Heartbeat transport.** How do agents report state — a Kylon connection, a local daemon, a Git hook? Affects latency and setup friction.
3. **Granularity.** File-level is the MVP. Is hunk/symbol-level worth it, or does it just add false negatives?
4. **Blocking policy.** When (if ever) do we hard-block vs. only warn?
5. **Multi-repo / monorepo.** Does the predicted-set logic change across repo layouts?

## 6. MVP cut

Smallest thing that proves the core claim:

- Explicit + structural prediction only (skip the heuristic model pass).
- File-level granularity.
- Advisory warnings only, to the shared channel.
- One demo scenario: two agents, one deliberate overlap, conflict surfaced before either commits.

If that catches the overlap reliably and the warning lands before the edit, the thesis holds. Everything else is refinement.

---

## Implementation status (maintained alongside the code)

| Doc section | Where it lives | Status |
|---|---|---|
| §3a explicit + structural prediction | `hooks/lib/predict.mjs` | ✅ deterministic, ~50ms, no model pass |
| §3b heartbeat (id, branch, predicted set, uncommitted edits, status) | activity rows via `hooks/lib/kylon.mjs`; presence online/idle in `session-start` / `stop` | ✅ |
| §3c intersect on every prompt | `hooks/user-prompt-submit.mjs` | ✅ predicted∩predicted and predicted∩active |
| §2 tier ranking | `detectPromptConflicts` in `hooks/lib/overlap.mjs` | ✅ overlap / active-collision; hunk-level = existing `detectOverlap` |
| §4 inline warning at the decision point | `UserPromptSubmit` additionalContext, pre-edit | ✅ verified in e2e sim |
| §4 single deduped channel message | `shouldAnnounce` (10-min TTL per file/dev/tier) | ✅ |
| §4 resolution options (a/b/c) | `formatPromptConflicts` | ✅ |
| §5.1 accuracy floor | non-source files excluded from structural hits; tokens matching >10 files dropped as too generic | partial — needs measurement against real runs |
| §5.2 heartbeat transport | DECIDED: Claude Code hooks → Kylon workspace files (one `file write` per report, `state-<dev>.json` + roster) + `#dev-sync` channel messages; live-verified 2026-07-16, ~1.5–4s per prompt hook | ✅ |
| §5.4 blocking policy | DECIDED: second prompter yields (first-come priority by heartbeat timestamp). On ACTIVE COLLISION the later agent must not touch the conflicting files, explains the refusal to its user with alternatives, and does the non-conflicting work. Hard infra-level blocks: still not used (demos badly). | ✅ |
| prompts visible in Kylon | every prompt is posted to #dev-sync (`💬 prompted on branch: "..."`) — the team sees the request stream, and first-come priority is auditable | ✅ |
| §3a heuristic model pass | skipped per §6 MVP cut | future |
