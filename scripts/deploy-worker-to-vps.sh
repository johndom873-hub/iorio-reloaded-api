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
# Exact text ibkrGatewayWorker.ts logs once it has connected to IBKR and registered its
# listeners — the health check's proof the new process is genuinely up, not just forked.
STARTUP_SUCCESS_MARKER="Iorio worker started — persistent IBKR connection, order placement, position sync."
HEALTH_CHECK_TIMEOUT_S=30

if [[ "$TARGET" == "live" ]]; then
  # Restarting the live worker interrupts order handling and reconciliation, and
  # today that unit is stopped and disabled on purpose (frozen prod). Make the
  # human type the target back so this can never happen by autopilot.
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
ssh -i "$VPS_SSH_KEY" "$VPS_USER@$VPS_HOST" bash -s <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"

echo "--- fetching origin/main ---"
git fetch origin main
NEW_COMMIT=\$(git rev-parse origin/main)
CURRENT_COMMIT=\$(git rev-parse HEAD)
REPO_URL=\$(git remote get-url origin)
# The bootstrap clone authenticates via a repo-local core.sshCommand override (a dedicated
# read-only deploy key), not anything global/ambient — a fresh \`git clone\` elsewhere on this
# machine does NOT inherit it, so it has to be read from here and passed through explicitly.
SSH_COMMAND=\$(git config --get core.sshCommand || true)

if [ "\$NEW_COMMIT" = "\$CURRENT_COMMIT" ]; then
  echo "DEPLOY_RESULT=skipped_no_new_commit CURRENT=\$CURRENT_COMMIT"
  echo "Already at \$CURRENT_COMMIT — nothing to deploy."
  exit 0
fi

NEXT_DIR="${REMOTE_DIR}.next"
PREV_DIR="${REMOTE_DIR}.prev"

# Leftover from a previous run that was interrupted before it got this far.
rm -rf "\$NEXT_DIR"

echo "--- building \$NEW_COMMIT in a fresh, independent checkout (current process, on \$CURRENT_COMMIT, keeps running throughout) ---"
# --reference + --dissociate: borrow \$REMOTE_DIR's already-fetched objects for speed
# (no re-download over the network for a commit it just fetched above), but the result
# is a fully independent repo, not a worktree — safe to freely rename/delete later
# without corrupting or breaking anything back in \$REMOTE_DIR (a real git worktree
# would break the moment either side of the pair gets renamed, since worktrees track
# each other's absolute paths internally).
if [ -n "\$SSH_COMMAND" ]; then
  git -c core.sshCommand="\$SSH_COMMAND" clone --quiet --reference "$REMOTE_DIR" --dissociate "\$REPO_URL" "\$NEXT_DIR"
  git -C "\$NEXT_DIR" config core.sshCommand "\$SSH_COMMAND"
else
  git clone --quiet --reference "$REMOTE_DIR" --dissociate "\$REPO_URL" "\$NEXT_DIR"
fi
git -C "\$NEXT_DIR" checkout --quiet --detach "\$NEW_COMMIT"
cp "$REMOTE_DIR/.env" "\$NEXT_DIR/.env"
( cd "\$NEXT_DIR" && npm ci && npm run build )

echo "--- build verified — swapping in atomically ---"
rm -rf "\$PREV_DIR"
mv "$REMOTE_DIR" "\$PREV_DIR"
mv "\$NEXT_DIR" "$REMOTE_DIR"

echo "--- restarting $SYSTEMD_UNIT on the new build ---"
systemctl restart "$SYSTEMD_UNIT"

echo "--- health check: waiting up to ${HEALTH_CHECK_TIMEOUT_S}s for a clean startup ---"
DEADLINE=\$((SECONDS + ${HEALTH_CHECK_TIMEOUT_S}))
HEALTHY=0
while [ "\$SECONDS" -lt "\$DEADLINE" ]; do
  if ! systemctl is-active --quiet "$SYSTEMD_UNIT"; then
    break
  fi
  if journalctl -u "$SYSTEMD_UNIT" --since "-$((HEALTH_CHECK_TIMEOUT_S + 10)) seconds" --no-pager 2>/dev/null | grep -qF "$STARTUP_SUCCESS_MARKER"; then
    HEALTHY=1
    break
  fi
  sleep 2
done

if [ "\$HEALTHY" != "1" ]; then
  echo "!!! \$NEW_COMMIT did not report a healthy startup within ${HEALTH_CHECK_TIMEOUT_S}s — rolling back to \$CURRENT_COMMIT !!!" >&2
  FAILED_DIR="${REMOTE_DIR}.failed-\$(date +%s)"
  mv "$REMOTE_DIR" "\$FAILED_DIR"
  mv "\$PREV_DIR" "$REMOTE_DIR"
  systemctl restart "$SYSTEMD_UNIT"
  echo "DEPLOY_RESULT=rolled_back FAILED_COMMIT=\$NEW_COMMIT CURRENT=\$CURRENT_COMMIT FAILED_BUILD_KEPT_AT=\$FAILED_DIR"
  echo "Rolled back to \$CURRENT_COMMIT. The failed build is kept at \$FAILED_DIR for inspection." >&2
  exit 1
fi

echo "--- healthy on \$NEW_COMMIT — cleaning up the previous build ---"
rm -rf "\$PREV_DIR"
echo "DEPLOY_RESULT=deployed PREVIOUS=\$CURRENT_COMMIT CURRENT=\$NEW_COMMIT"
echo "Deployed \$CURRENT_COMMIT -> \$NEW_COMMIT."
systemctl status "$SYSTEMD_UNIT" --no-pager -l
REMOTE

echo "Done. Tail logs with: ssh -i $VPS_SSH_KEY $VPS_USER@$VPS_HOST journalctl -u $SYSTEMD_UNIT -f"
