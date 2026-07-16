#!/usr/bin/env bash
# One-command check: has Kylon enabled external agents on this workspace yet?
# All CLI syntax below was verified against the real `kylon` CLI on 2026-07-16.
#
# Exit codes:
#   0  external agents enabled — self-register succeeded, gateway can run
#   1  still gated (400 "External agents are only enabled in development")
#   2  some other error — printed raw for debugging
#
# Quirk: on error, `kylon agent self-register --json` does NOT emit JSON — it
# logs a plain error line to stderr, so we match on the message text.
set -euo pipefail

WORKSPACE_ID="7f179165eca8"

echo "== Collab gateway preflight =="

if ! command -v kylon >/dev/null 2>&1; then
  echo "Install the Kylon CLI first — see https://docs.kylon.io/cli/installation" >&2
  exit 2
fi

echo "-- attempting external-agent self-registration:"
set +e
OUTPUT=$(kylon agent self-register --provider claude-code --name "collab-$USER" --yes --json 2>&1)
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  echo "   enabled! External agent registered."
  echo "$OUTPUT"
  echo ""
  echo "Next step — start the gateway so #dev-sync @mentions reach your local Claude Code:"
  echo "  kylon gateway run --server-url https://api.kylon.io --provider claude-code"
  exit 0
fi

if echo "$OUTPUT" | grep -q "External agents are only enabled in development"; then
  echo "   still gated (400: External agents are only enabled in development)"
  echo ""
  echo "Send this to Kylon support:"
  echo "  \"Please enable external agents on workspace $WORKSPACE_ID — we're building"
  echo "   on the CLI gateway with the claude-code provider\""
  exit 1
fi

echo "   unexpected error (exit $STATUS) — raw output for debugging:" >&2
echo "$OUTPUT" >&2
exit 2
