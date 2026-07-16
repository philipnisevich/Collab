# Demo script — "the collision" (~3 minutes)

## Setup (before you're on stage)

- Both laptops: gateway running (`kylon gateway run --provider claude-code`),
  demo repo cloned, hooks installed, `.collab.json` with each dev's name.
- Kylon workspace open on the projector: `#dev-sync` channel visible.
- **Record a full backup take the night before.** Venue Wi-Fi kills live demos.
- `git fetch` both branches clean; rehearse the exact prompts below at least twice.

## Beat 1 — the problem (30s)

> "Hackathon teams lose their last three hours to merge hell. Two people, one
> repo, and neither knows what the other's AI just rewrote. We fixed that at
> the *agent* level."

## Beat 2 — both agents online (20s)

Both devs open Claude Code. Point at the projector: two 🟢 presence messages
appear in `#dev-sync`. "Our agents just introduced themselves."

## Beat 3 — the collision (90s)

- **Dev B** prompts first: *"Add an in-memory cache to getUser in src/users.mjs."*
- **Dev A**, ~10s later: *"Rename getUser to fetchUser across the codebase."*

Narrate what the audience sees:
1. Dev A's agent receives injected context — it *already knows* B's agent is
   inside `src/users.mjs` lines 5–10 (show the transcript line).
2. The moment A's agent edits the shared lines, the ⚠️ HIGH conflict warning
   fires **mid-turn** on the projector transcript.
3. A's agent posts to `#dev-sync`: *"renaming getUser→fetchUser, same
   signature — update your callers."* The message appears in Kylon for everyone.
4. B's agent picks it up and adapts — caches `fetchUser`, not the dead name.

## Beat 4 — the payoff (30s)

```bash
git merge feat-a feat-b   # or: git merge-tree for the dry version
```

> "Clean merge. No conflict markers. The agents negotiated the conflict away
> *while the code was being written* — not three hours later at the merge."

## Fallbacks

- Wi-Fi dies → dry-run mode (`"dryRun": true`, shared `.collab/` dir) runs the
  identical choreography locally on one laptop with two worktrees.
- Anything else dies → play the backup recording.
