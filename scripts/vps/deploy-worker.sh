#!/usr/bin/env bash
# VPS-resident atomic build-then-swap deploy for a worker. Installed as /opt/ibkr/deploy-worker.sh;
# the forced-command keys keep calling /opt/ibkr/deploy-worker-<target>.sh, which are two-line wrappers:
#   exec /opt/ibkr/deploy-worker.sh <staging|live>
# so the target is fixed by the wrapper and never accepted from the SSH client.
#
# Privilege split: git runs as root (a clone executes no repo code), but `npm ci && npm run build` run
# as the unprivileged build user, which can never read a .env. The built tree is handed back to root,
# the .env is copied in only after the build, and the worker runs as its own runtime user
# (harden-worker-service.sh). A malicious dependency install script therefore never gets root or any secret.
set -euo pipefail

TARGET="${1:-}"
case "$TARGET" in
  staging)
    REMOTE_DIR="/opt/iorio-worker-staging"
    SYSTEMD_UNIT="iorio-worker-staging"
    RUNTIME_USER="iorio-worker-staging"
    ;;
  live)
    REMOTE_DIR="/opt/iorio-worker"
    SYSTEMD_UNIT="iorio-worker"
    RUNTIME_USER="iorio-worker-live"
    ;;
  *)
    echo "Usage: $0 <staging|live>   (target is mandatory)" >&2
    exit 2
    ;;
esac

BUILD_USER="iorio-build"
BUILD_HOME="/var/lib/iorio-build"
STARTUP_SUCCESS_MARKER="Iorio worker started — persistent IBKR connection, order placement, position sync."
HEALTH_CHECK_TIMEOUT_S=30

cd "$REMOTE_DIR"

echo "--- fetching origin/main ---"
git fetch origin main
NEW_COMMIT=$(git rev-parse origin/main)
CURRENT_COMMIT=$(git rev-parse HEAD)
REPO_URL=$(git remote get-url origin)
SSH_COMMAND=$(git config --get core.sshCommand || true)

# DEPLOY_FORCE_REBUILD is only honoured when the script is started locally by root; a forced command
# gets no client-chosen environment.
if [ "$NEW_COMMIT" = "$CURRENT_COMMIT" ] && [ "${DEPLOY_FORCE_REBUILD:-}" != "1" ]; then
  echo "DEPLOY_RESULT=skipped_no_new_commit CURRENT=$CURRENT_COMMIT"
  echo "Already at $CURRENT_COMMIT — nothing to deploy."
  exit 0
fi

NEXT_DIR="${REMOTE_DIR}.next"
PREV_DIR="${REMOTE_DIR}.prev"

rm -rf "$NEXT_DIR"

echo "--- building $NEW_COMMIT in a fresh, independent checkout (current process, on $CURRENT_COMMIT, keeps running throughout) ---"
if [ -n "$SSH_COMMAND" ]; then
  git -c core.sshCommand="$SSH_COMMAND" clone --quiet --reference "$REMOTE_DIR" --dissociate "$REPO_URL" "$NEXT_DIR"
  git -C "$NEXT_DIR" config core.sshCommand "$SSH_COMMAND"
else
  git clone --quiet --reference "$REMOTE_DIR" --dissociate "$REPO_URL" "$NEXT_DIR"
fi
git -C "$NEXT_DIR" checkout --quiet --detach "$NEW_COMMIT"

chown -R "$BUILD_USER":"$BUILD_USER" "$NEXT_DIR"
runuser -u "$BUILD_USER" -- env HOME="$BUILD_HOME" bash -c "cd '$NEXT_DIR' && npm ci && npm run build"
chown -R root:root "$NEXT_DIR"
install -o root -g "$RUNTIME_USER" -m 0640 "$REMOTE_DIR/.env" "$NEXT_DIR/.env"

echo "--- build verified — swapping in atomically ---"
rm -rf "$PREV_DIR"
mv "$REMOTE_DIR" "$PREV_DIR"
mv "$NEXT_DIR" "$REMOTE_DIR"

echo "--- restarting $SYSTEMD_UNIT on the new build ---"
systemctl restart "$SYSTEMD_UNIT"

echo "--- health check: waiting up to ${HEALTH_CHECK_TIMEOUT_S}s for a clean startup ---"
# Scoped to the exact new PID via journald's _PID= field, not a --since window, which can miss lines under rapid restarts.
DEADLINE=$((SECONDS + HEALTH_CHECK_TIMEOUT_S))
HEALTHY=0
NEW_PID=""
while [ "$SECONDS" -lt "$DEADLINE" ] && [ -z "$NEW_PID" ]; do
  NEW_PID=$(systemctl show -p MainPID --value "$SYSTEMD_UNIT")
  [ "$NEW_PID" = "0" ] && NEW_PID=""
  [ -z "$NEW_PID" ] && sleep 1
done
if [ -z "$NEW_PID" ]; then
  echo "Could not read a MainPID for $SYSTEMD_UNIT after restart." >&2
else
  while [ "$SECONDS" -lt "$DEADLINE" ]; do
    if ! systemctl is-active --quiet "$SYSTEMD_UNIT"; then
      break
    fi
    # No `grep -q`: it exits at the first match while journalctl is still writing, journalctl dies of
    # SIGPIPE (141), and pipefail then turns a found marker into a failed check.
    if journalctl "_PID=$NEW_PID" --no-pager 2>/dev/null | grep -F "$STARTUP_SUCCESS_MARKER" >/dev/null; then
      HEALTHY=1
      break
    fi
    sleep 2
  done
fi

if [ "$HEALTHY" != "1" ]; then
  echo "!!! $NEW_COMMIT did not report a healthy startup within ${HEALTH_CHECK_TIMEOUT_S}s — rolling back to $CURRENT_COMMIT !!!" >&2
  FAILED_DIR="${REMOTE_DIR}.failed-$(date +%s)"
  mv "$REMOTE_DIR" "$FAILED_DIR"
  mv "$PREV_DIR" "$REMOTE_DIR"
  systemctl restart "$SYSTEMD_UNIT"
  echo "DEPLOY_RESULT=rolled_back FAILED_COMMIT=$NEW_COMMIT CURRENT=$CURRENT_COMMIT FAILED_BUILD_KEPT_AT=$FAILED_DIR"
  echo "Rolled back to $CURRENT_COMMIT. The failed build is kept at $FAILED_DIR for inspection." >&2
  exit 1
fi

echo "--- healthy on $NEW_COMMIT — cleaning up the previous build ---"
rm -rf "$PREV_DIR"
echo "DEPLOY_RESULT=deployed PREVIOUS=$CURRENT_COMMIT CURRENT=$NEW_COMMIT"
echo "Deployed $CURRENT_COMMIT -> $NEW_COMMIT."
