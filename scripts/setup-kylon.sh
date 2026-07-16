#!/usr/bin/env bash
# Wire a repo to a live Kylon workspace. All CLI syntax below was verified
# against the real `kylon` CLI on 2026-07-16.
#
# Prereq: `kylon auth login --server-url https://api.kylon.io` (a saved login
# session is enough — no pak_ key required for workspace commands).
set -euo pipefail

COLLAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANNEL_NAME="${COLLAB_CHANNEL:-dev-sync}"

echo "== Collab × Kylon setup =="

if ! command -v kylon >/dev/null 2>&1; then
  echo "Install the Kylon CLI first — see https://docs.kylon.io/cli/installation" >&2
  exit 1
fi

echo "-- auth:"
kylon auth status || { echo "Run: kylon auth login --server-url https://api.kylon.io" >&2; exit 1; }

echo "-- channel #$CHANNEL_NAME:"
EXISTING=$(kylon workspace channel list --query "$CHANNEL_NAME" | sed -n "s/^- \([0-9a-f]*\)[[:space:]]*#$CHANNEL_NAME .*/\1/p" | head -1)
if [ -n "$EXISTING" ]; then
  CHANNEL_ID="$EXISTING"
  echo "   exists: $CHANNEL_ID"
else
  OUT=$(kylon workspace channel create "$CHANNEL_NAME" --scope public \
    --task "Real-time coordination between Claude Code agents" \
    --context "Collab posts agent presence, conflict warnings, and coordination messages here. Humans arbitrate overlaps.")
  CHANNEL_ID=$(echo "$OUT" | sed -n 's/.*(id: \([0-9a-f]*\)).*/\1/p')
  echo "   created: $CHANNEL_ID"
fi

echo "-- smoke test (message + state file):"
kylon workspace message send --channel "$CHANNEL_ID" --text "[setup] Collab wired for $USER" >/dev/null
kylon workspace file write --path /workspace/shared/collab/setup-check.json --content "{\"by\":\"$USER\",\"ts\":$(date +%s)}" >/dev/null
echo "   ok"

echo ""
echo "Done. In each repo you want coordinated:"
echo "  node \"$COLLAB_ROOT/hooks/install.mjs\" /path/to/repo"
echo "  then edit .collab.json:"
echo "    { \"dev\": \"<your-name>\", \"channel\": \"$CHANNEL_NAME\", \"channelId\": \"$CHANNEL_ID\", \"dryRun\": false }"
echo ""
echo "Optional (needs external agents enabled on the workspace):"
echo "  kylon gateway run --server-url https://api.kylon.io --provider claude-code"
