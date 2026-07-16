#!/usr/bin/env bash
# Materialize the demo project as its own git repo with Collab hooks installed,
# plus two worktrees (dev-a / dev-b) for single-machine testing.
#
#   scripts/setup-demo.sh [target-dir]   (default: ~/collab-demo)
set -euo pipefail

COLLAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$HOME/collab-demo}"

if [ -e "$TARGET" ]; then
  echo "error: $TARGET already exists — remove it or pick another path" >&2
  exit 1
fi

mkdir -p "$TARGET"
cp -R "$COLLAB_ROOT/demo-app/." "$TARGET/"
cd "$TARGET"
git init -q -b main
git add -A
git commit -qm "demo-app: initial commit"

node "$COLLAB_ROOT/hooks/install.mjs" "$TARGET"

# Two worktrees simulating the two developers (share one .collab dir so the
# dry-run transport connects them).
SHARED="$TARGET/.collab"
mkdir -p "$SHARED"
git branch feat-a
git branch feat-b
git worktree add -q ../"$(basename "$TARGET")-dev-a" feat-a
git worktree add -q ../"$(basename "$TARGET")-dev-b" feat-b

for DEV in a b; do
  WT="$(dirname "$TARGET")/$(basename "$TARGET")-dev-$DEV"
  node "$COLLAB_ROOT/hooks/install.mjs" "$WT" 2>/dev/null || true
  cat > "$WT/.collab.json" <<EOF
{
  "dev": "dev-$DEV",
  "channel": "dev-sync",
  "table": "activity",
  "dryRun": true,
  "sharedDir": "$SHARED"
}
EOF
done

echo ""
echo "Demo ready:"
echo "  main repo : $TARGET"
echo "  dev A     : $(dirname "$TARGET")/$(basename "$TARGET")-dev-a  (branch feat-a)"
echo "  dev B     : $(dirname "$TARGET")/$(basename "$TARGET")-dev-b  (branch feat-b)"
echo ""
echo "Open Claude Code in each worktree (two terminals) and run the collision:"
echo "  A: 'Rename getUser to fetchUser across the codebase'"
echo "  B: 'Add an in-memory cache to getUser'"
