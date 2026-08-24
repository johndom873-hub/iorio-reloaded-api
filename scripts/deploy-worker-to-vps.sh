#!/usr/bin/env bash
# Deploys the latest pushed `main` to the persistent worker process
# (src/worker.ts) running on the VPS — see PROGRESS.md's "Worker deploy
# location decided 2026-08-24" entry. Unlike the web/app repos, this does
# NOT auto-deploy from a GitHub push: worker.ts changes need this script run
# by hand afterward.
#
# Assumes the one-time bootstrap from that PROGRESS.md entry is already
# done: repo cloned to $REMOTE_DIR on the VPS (via the dedicated
# iorio-vps-worker-deploy read-only deploy key), .env written, and a
# systemd unit named $SYSTEMD_UNIT installed and enabled. That bootstrap is
# still blocked on Juan adding the deploy key to GitHub as of 2026-08-24 —
# this script is for every update *after* that one-time setup, so the exact
# path/unit name below may need adjusting once that setup actually happens.
set -euo pipefail

VPS_HOST="142.132.185.128"
VPS_USER="root"
VPS_SSH_KEY="$HOME/.ssh/iorio_vps_ed25519"
REMOTE_DIR="/opt/iorio-worker"
SYSTEMD_UNIT="iorio-worker"

cd "$(dirname "$0")/.."

LOCAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$LOCAL_BRANCH" != "main" ]]; then
  echo "Warning: local branch is '$LOCAL_BRANCH', not main. The VPS always deploys origin/main regardless of what's checked out locally." >&2
fi

git fetch origin main >/dev/null 2>&1 || true
LOCAL_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "")
if [[ -n "$LOCAL_HEAD" && -n "$REMOTE_HEAD" && "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
  echo "Warning: local HEAD ($LOCAL_HEAD) differs from origin/main ($REMOTE_HEAD)." >&2
  echo "This script deploys whatever is currently pushed to origin/main, not your local working tree — push first if you meant to include recent commits." >&2
fi

if [[ ! -f "$VPS_SSH_KEY" ]]; then
  echo "SSH key not found at $VPS_SSH_KEY" >&2
  exit 1
fi

echo "Deploying origin/main to $VPS_USER@$VPS_HOST:$REMOTE_DIR..."
ssh -i "$VPS_SSH_KEY" "$VPS_USER@$VPS_HOST" bash -s <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"
echo "--- git pull ---"
git fetch origin main
git reset --hard origin/main
echo "--- npm ci ---"
npm ci
echo "--- build ---"
npm run build
echo "--- restart $SYSTEMD_UNIT ---"
systemctl restart "$SYSTEMD_UNIT"
sleep 3
systemctl status "$SYSTEMD_UNIT" --no-pager -l
REMOTE

echo "Done. Tail logs with: ssh -i $VPS_SSH_KEY $VPS_USER@$VPS_HOST journalctl -u $SYSTEMD_UNIT -f"
