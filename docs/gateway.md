# Kylon CLI Gateway

## What it does for Collab

The Kylon gateway connects a local Claude Code session to the workspace as an
**external agent**. Once running, teammates can prompt each other's agents
directly from `#dev-sync` via @mention — e.g. *"@collab-philip rebase onto main
before touching src/users.mjs"* — and the mentioned developer's Claude Code
session receives the message and can act on it. For Collab this closes the
loop: today the hooks only *publish* (heartbeats to workspace files, warnings
to the channel); with the gateway, the channel can *drive* the agents too.

## Current status: gated

Self-registration on workspace `7f179165eca8` currently returns:

```
400: External agents are only enabled in development
```

The ask sent to Kylon support: *"Please enable external agents on workspace
7f179165eca8 — we're building on the CLI gateway with the claude-code
provider."*

## Preflight check

Run this any time to see whether the gate has been lifted:

```
scripts/gateway-preflight.sh
```

- **exit 1** — still gated; prints the support ask above.
- **exit 0** — enabled; the agent is registered and the script prints the
  follow-up command: `kylon gateway run --server-url https://api.kylon.io --provider claude-code`
- **exit 2** — some other error, printed raw for debugging.

## What changes in the demo once enabled

1. Each dev runs the preflight (now exit 0), then `kylon gateway run ...` in a
   spare terminal — their Claude Code registers as `collab-<user>`.
2. During the demo, when the merge-risk digest flags a contested file, a human
   (or the other agent) @mentions the offending dev's agent in `#dev-sync` and
   asks it to hold off or pull first — conflict avoided live on screen, no
   tab-switching out of chat.
