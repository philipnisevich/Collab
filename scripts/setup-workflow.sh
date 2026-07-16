#!/usr/bin/env bash
# Create the `collab-merge-risk-digest` scheduled workflow in #dev-sync.
# All CLI syntax below was verified against the real `kylon` CLI on 2026-07-16.
#
# Notable quirks vs the printed help:
#   - `workflow create` requires an undocumented `--agent <agent_id>` (the
#     workspace agent that executes runs). We discover it via `workspace search`
#     or take it from $COLLAB_AGENT_ID.
#   - All workflow subcommands require `--scope-channel <channel_id>`.
#
# The workflow reads /workspace/shared/collab/roster.json plus each
# state-<dev>.json, intersects the devs' predicted+active file sets, and posts
# a short merge-risk digest to #dev-sync every 15 minutes (--publish).
#
# DEFAULT: the schedule is created PAUSED so it doesn't burn workspace credits
# before the hackathon. Resume it with the command printed at the end.
set -euo pipefail

CHANNEL_ID="${COLLAB_CHANNEL_ID:-c25f6c73c97c}"
WORKFLOW_NAME="collab-merge-risk-digest"

echo "== Collab merge-risk digest workflow =="

if ! command -v kylon >/dev/null 2>&1; then
  echo "Install the Kylon CLI first — see https://docs.kylon.io/cli/installation" >&2
  exit 1
fi

echo "-- auth:"
kylon auth status || { echo "Run: kylon auth login --server-url https://api.kylon.io" >&2; exit 1; }

echo "-- checking for existing workflow:"
# List format (verified): - <id>  "<name>"  enabled: true  next: <iso>
EXISTING=$(kylon workspace workflow list --scope-channel "$CHANNEL_ID" --query "$WORKFLOW_NAME" \
  | sed -n "s/^- \([0-9a-f]*\)[[:space:]]*\"$WORKFLOW_NAME\".*/\1/p" | head -1)

if [ -n "$EXISTING" ]; then
  WORKFLOW_ID="$EXISTING"
  echo "   exists: $WORKFLOW_ID (leaving it as-is)"
else
  echo "-- resolving workspace agent id:"
  # `workflow create` needs --agent. Discover the Collab workspace agent from
  # global search (DM row format: - [Collab](/channel/<id>)  user=<id>  type=agent ...).
  AGENT_ID="${COLLAB_AGENT_ID:-$(kylon workspace search collab \
    | sed -n 's/.*user=\([0-9a-f]*\)[[:space:]]*type=agent.*/\1/p' | head -1)}"
  if [ -z "$AGENT_ID" ]; then
    echo "Could not discover a workspace agent id. Set COLLAB_AGENT_ID and re-run." >&2
    exit 1
  fi
  echo "   agent: $AGENT_ID"

  # Quoted heredoc: the prompt reaches Kylon verbatim, no shell expansion.
  MESSAGE=$(cat <<'PROMPT'
You are the Collab merge-risk digest for this dev channel.

Steps:
1. Read /workspace/shared/collab/roster.json. Schema: {"devs":{"<dev-name>":<ts_ms>, ...}}.
2. For each dev name, read /workspace/shared/collab/state-<dev-name>.json. Schema: {"dev":string,"branch":string,"status":string,"predicted":[{"file":string,...}],"active":[{"file":string,"start":int,"end":int,...}],"ts":<epoch ms>}. A state file whose top-level ts is older than 30 minutes (now_ms - ts > 1800000) is STALE — ignore that dev entirely. A missing state file is not an error; skip that dev.
3. For each non-stale dev, build their file set = union of predicted[].file and active[].file. A file is CONTESTED when it appears in 2+ devs file sets. A contested file is ACTIVE when it appears in any devs active[] list. A file is CLEAR when it appears in exactly one devs set.
4. Post ONE short digest message, 3 lines max, no extra commentary:
   - With contested files: "🛰 Merge-risk digest: <devA> (<branchA>) and <devB> (<branchB>) both in <file> [ACTIVE ⚠]; <N> files contested, <M> clear" — append " [ACTIVE ⚠]" only to contested files that are active, list each contested file, and end with the contested/clear counts.
   - With no contested files (or fewer than 2 fresh devs): "🛰 Merge-risk digest: no contested files"
PROMPT
)

  echo "-- creating workflow (every 15 min, published to channel):"
  OUT=$(kylon workspace workflow create --scope-channel "$CHANNEL_ID" \
    --agent "$AGENT_ID" \
    --name "$WORKFLOW_NAME" \
    --message "$MESSAGE" \
    --schedule '{"kind":"every","everyMs":900000}' \
    --expect 'A single chat message of at most 3 lines starting with "🛰 Merge-risk digest:", either listing contested files with contested/clear counts or stating "no contested files".' \
    --publish)
  # Create output (verified): Created workflow "<name>" (id: <id>, next: <iso>)
  WORKFLOW_ID=$(echo "$OUT" | sed -n 's/.*(id: \([0-9a-f]*\).*/\1/p')
  echo "   created: $WORKFLOW_ID"

  echo "-- pausing schedule (default — avoids burning credits pre-hackathon):"
  kylon workspace workflow pause "$WORKFLOW_ID" --scope-channel "$CHANNEL_ID"
  echo "   paused (manual triggers still work)"
fi

echo ""
echo "Done. Workflow \"$WORKFLOW_NAME\" ($WORKFLOW_ID) in channel $CHANNEL_ID."
echo "NOTE: the 15-minute schedule is PAUSED by default."
echo "  resume schedule:  kylon workspace workflow resume $WORKFLOW_ID --scope-channel $CHANNEL_ID"
echo "  run once now:     kylon workspace workflow trigger $WORKFLOW_ID --scope-channel $CHANNEL_ID"
echo "  check runs:       kylon workspace workflow runs $WORKFLOW_ID --scope-channel $CHANNEL_ID"
