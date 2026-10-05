#!/usr/bin/env bash
# One-time, idempotent setup that stops a VPS worker running as root. Run as root ON the VPS:
#   bash harden-worker-service.sh <staging|live>
#
# Creates a dedicated no-shell runtime user per environment (a compromised staging worker must not be
# able to read the live worker's .env) and one shared build user for `npm ci && npm run build`
# (see deploy-worker.sh). Hardening goes in a systemd drop-in, so the unit file itself is untouched
# and rollback is deleting the drop-in. This script only prepares; it does NOT restart the worker.
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
NOLOGIN_SHELL="/usr/sbin/nologin"

if [ "$(id -u)" != "0" ]; then
  echo "Run as root." >&2
  exit 1
fi
[ -f "$REMOTE_DIR/.env" ] || { echo "$REMOTE_DIR/.env not found." >&2; exit 1; }

id -u "$RUNTIME_USER" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell "$NOLOGIN_SHELL" "$RUNTIME_USER"
id -u "$BUILD_USER" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$BUILD_HOME" --create-home --shell "$NOLOGIN_SHELL" "$BUILD_USER"

# The worker reads its own git sha with `git rev-parse` in a root-owned checkout; git refuses that
# for a different user unless the directory is listed as safe.
git config --system --get-all safe.directory | grep -qxF "$REMOTE_DIR" || git config --system --add safe.directory "$REMOTE_DIR"

# Code stays root-owned and world-readable (not secret); only .env is restricted to the runtime user.
chown root:"$RUNTIME_USER" "$REMOTE_DIR/.env"
chmod 0640 "$REMOTE_DIR/.env"

DROP_IN_DIRECTORY="/etc/systemd/system/${SYSTEMD_UNIT}.service.d"
mkdir -p "$DROP_IN_DIRECTORY"
cat > "$DROP_IN_DIRECTORY/hardening.conf" <<DROP_IN
[Service]
User=${RUNTIME_USER}
Group=${RUNTIME_USER}
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
DROP_IN
systemctl daemon-reload

echo "Prepared $SYSTEMD_UNIT to run as $RUNTIME_USER. NOT restarted: it still runs as before until you run: systemctl restart $SYSTEMD_UNIT"
echo "Rollback: rm $DROP_IN_DIRECTORY/hardening.conf && systemctl daemon-reload && systemctl restart $SYSTEMD_UNIT"
