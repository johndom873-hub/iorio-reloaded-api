#!/usr/bin/env bash
# Controls ONLY the staging worker (iorio-worker-staging) on the VPS: there is no
# way to name another unit, and no "live" target on purpose (the live worker is
# stopped and disabled; touching it must stay a deliberate, manual act).
#
#   npm run worker:staging -- status
#   npm run worker:staging -- logs [lines]     (default 50, max 500)
#   npm run worker:staging -- stop | start | restart
set -euo pipefail

VPS_HOST="142.132.185.128"
VPS_USER="root"
VPS_SSH_KEY="$HOME/.ssh/iorio_vps_ed25519"
SYSTEMD_UNIT="iorio-worker-staging"
REMOTE_DIR="/opt/iorio-worker-staging"

ACTION="${1:-}"
ssh_run() { ssh -i "$VPS_SSH_KEY" -o ConnectTimeout=10 "$VPS_USER@$VPS_HOST" "$1"; }

case "$ACTION" in
  status)
    ssh_run "systemctl is-active $SYSTEMD_UNIT; systemctl show $SYSTEMD_UNIT -p ActiveEnterTimestamp; cd $REMOTE_DIR && git rev-parse --short HEAD"
    ;;
  logs)
    LINES="${2:-50}"
    [[ "$LINES" =~ ^[0-9]+$ ]] && (( LINES >= 1 && LINES <= 500 )) || { echo "logs: lines must be 1-500" >&2; exit 2; }
    ssh_run "journalctl -u $SYSTEMD_UNIT -n $LINES --no-pager"
    ;;
  stop|start|restart)
    ssh_run "systemctl $ACTION $SYSTEMD_UNIT; sleep 2; systemctl is-active $SYSTEMD_UNIT || true"
    ;;
  *)
    echo "Usage: $0 <status|logs [lines]|stop|start|restart>   (staging worker only)" >&2
    exit 2
    ;;
esac
