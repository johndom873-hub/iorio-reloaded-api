#!/usr/bin/env bash
# Deploys the latest pushed `main` to the persistent worker process
# (src/ibkrGatewayWorker.ts) running on the VPS — see PROGRESS.md's "Worker
# deploy location decided 2026-08-24" entry, and the "Phase B WP4" entry for
# why this is atomic build-then-swap rather than the old in-place
# git-reset-and-build. Unlike the web/app repos, this does NOT auto-deploy
# from a GitHub push on its own: ibkrGateway* changes need either this
# script run by hand, or (Phase B, in progress) the API's release phase
# calling it for you.
#
# Atomicity: the CURRENTLY RUNNING worker (in $REMOTE_DIR) is never touched
# while the new commit is fetched, cloned into a fresh independent checkout,
# and built — a failed build leaves $REMOTE_DIR and the running process
# completely untouched, and this script exits non-zero. Only once the build
# succeeds does $REMOTE_DIR get swapped (via `mv`, a single rename(2) per
# swap) for the new checkout, and only then is the service restarted. After
# restart, this script waits for a real "started cleanly" log line (not just
# "the process is still running" — Type=simple marks a unit active on fork,
# before the app has done anything) and automatically rolls back to the
# previous build if that never shows up, so a build that compiles fine but
# crashes on a bad .env/config at startup still self-heals instead of
# leaving the worker down.
#
# Assumes the one-time bootstrap from PROGRESS.md's "Worker deploy location
# decided" entry is already done: repo cloned to $REMOTE_DIR on the VPS (via
# the dedicated iorio-vps-worker-deploy read-only deploy key), .env written,
# and a systemd unit named $SYSTEMD_UNIT installed and enabled.
set -euo pipefail

# Mandatory target — there is deliberately no default. Two workers live on this
# VPS (staging and the old, future-prod one); guessing wrong once restarted the
# wrong one's neighbour in the planning notes, so the caller must say which.
#   npm run deploy:worker:staging     (or: bash scripts/deploy-worker-to-vps.sh staging)
#   bash scripts/deploy-worker-to-vps.sh live
TARGET="${1:-}"
case "$TARGET" in
  staging)
    REMOTE_DIR="/opt/iorio-worker-staging"
    SYSTEMD_UNIT="iorio-worker-staging"
    ;;
  live)
    REMOTE_DIR="/opt/iorio-worker"
    SYSTEMD_UNIT="iorio-worker"
    ;;
  *)
    echo "Usage: $0 <staging|live>   (target is mandatory)" >&2
    exit 2
    ;;
esac

VPS_HOST="142.132.185.128"
VPS_USER="root"
VPS_SSH_KEY="$HOME/.ssh/iorio_vps_ed25519"

if [[ "$TARGET" == "live" ]]; then
  # Restarting the live worker interrupts order handling and reconciliation.
  # Make the human type the target back so this can never happen by autopilot.
  read -r -p "This restarts the LIVE worker ($SYSTEMD_UNIT in $REMOTE_DIR). Type 'live' to continue: " CONFIRMATION
  [[ "$CONFIRMATION" == "live" ]] || { echo "Aborted." >&2; exit 1; }
fi

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

echo "Deploying origin/main to $TARGET worker: $VPS_USER@$VPS_HOST:$REMOTE_DIR ($SYSTEMD_UNIT)..."
# The build, swap, restart, health check and rollback live in the VPS-resident /opt/ibkr/deploy-worker-<target>.sh,
# the same script the forced-command key runs, so a manual deploy and a release-phase deploy can never differ.
# (scripts/vps/deploy-worker.sh in this repo is the shared version those per-target files wrap.)
ssh -i "$VPS_SSH_KEY" "$VPS_USER@$VPS_HOST" "/opt/ibkr/deploy-worker-$TARGET.sh"

echo "Done. Tail logs with: ssh -i $VPS_SSH_KEY $VPS_USER@$VPS_HOST journalctl -u $SYSTEMD_UNIT -f"
