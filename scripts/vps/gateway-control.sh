#!/bin/bash
# Gateway control for the VPS. Lives at /opt/ibkr/gateway-control.sh and is invoked only through
# forced-command SSH keys (authorized_keys: command="/opt/ibkr/gateway-control.sh <action> <environment>"),
# so the caller can never choose the action or the environment.
#
#   fresh-login <paper|live>      Cold-restarts the Gateway container so IBC starts a new login. On live that
#                                 sends a fresh 2FA push (about 3 minutes to approve). Refuses when the API
#                                 already answers a real handshake, and when it already ran in the last 2 minutes.
#   restart-session <paper|live>  IBC's RESTART: the same in-process restart as the daily auto-restart, which
#                                 reuses the session (no re-login, no 2FA). Needs the IBC command server.
#
# The last line printed is always GATEWAY_CONTROL_RESULT=<kind>, for the caller to parse.
set -uo pipefail

readonly command_server_port=7462
readonly fresh_login_minimum_interval_seconds=120
readonly login_wait_seconds=60
readonly restart_down_wait_seconds=60
readonly restart_up_wait_seconds=240

ENVIRONMENT=""
CONTAINER=""
API_PORT=""

print_result() {
  echo "GATEWAY_CONTROL_RESULT=$1"
}

lock_file_path() {
  echo "/run/gateway-control-${ENVIRONMENT}-fresh-login"
}

seconds_since_modified() {
  echo $(( $(date +%s) - $(stat -c %Y "$1") ))
}

# A real API handshake, not a TCP check: the container's socat relay accepts connections even when the
# Gateway behind it is down, so only a reply to the handshake proves the API is up.
api_answers() {
  local port="$1"
  local reply_bytes
  reply_bytes=$(
    { exec 3<>"/dev/tcp/127.0.0.1/${port}"; } 2>/dev/null || exit 0
    printf 'API\0\0\0\0\011v100..176' >&3
    timeout 5 head -c 4 <&3 2>/dev/null | wc -c
  )
  [[ "${reply_bytes:-0}" -ge 4 ]]
}

two_factor_prompt_since() {
  docker logs --since "$1" "$CONTAINER" 2>&1 | grep -q "Second Factor Authentication initiated"
}

fresh_login() {
  local lock_file
  lock_file="$(lock_file_path)"
  if [[ -f "$lock_file" ]] && (( $(seconds_since_modified "$lock_file") < fresh_login_minimum_interval_seconds )); then
    print_result rate_limited
    return 0
  fi
  if api_answers "$API_PORT"; then
    print_result refused_api_already_answering
    return 0
  fi

  touch "$lock_file"
  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "restarting ${CONTAINER} for a fresh login"
  if ! docker restart "$CONTAINER" >/dev/null; then
    print_result restart_failed
    return 1
  fi

  local waited=0
  while (( waited < login_wait_seconds )); do
    sleep 5
    waited=$(( waited + 5 ))
    if api_answers "$API_PORT"; then
      print_result login_completed
      return 0
    fi
    if two_factor_prompt_since "$started_at"; then
      print_result waiting_for_2fa
      return 0
    fi
  done
  print_result login_started_unknown
}

restart_session() {
  if ! api_answers "$API_PORT"; then
    print_result refused_api_not_answering
    return 0
  fi

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if ! docker exec "$CONTAINER" bash -c "(echo RESTART; sleep 1; echo EXIT) | socat - TCP:127.0.0.1:${command_server_port}" >/dev/null 2>&1; then
    print_result command_server_not_enabled
    return 1
  fi

  local waited=0
  while api_answers "$API_PORT"; do
    if (( waited >= restart_down_wait_seconds )); then
      print_result restart_not_observed
      return 1
    fi
    sleep 3
    waited=$(( waited + 3 ))
  done

  waited=0
  until api_answers "$API_PORT"; do
    if two_factor_prompt_since "$started_at"; then
      print_result waiting_for_2fa
      return 1
    fi
    if (( waited >= restart_up_wait_seconds )); then
      print_result not_recovered
      return 1
    fi
    sleep 5
    waited=$(( waited + 5 ))
  done
  print_result session_restarted
}

main() {
  local action="${1:-}"
  ENVIRONMENT="${2:-}"
  case "$ENVIRONMENT" in
    paper) CONTAINER="iorio-ibkr-ib-gateway-paper-1"; API_PORT=4002 ;;
    live) CONTAINER="iorio-ibkr-ib-gateway-live-1"; API_PORT=4001 ;;
    *) echo "usage: gateway-control.sh <fresh-login|restart-session> <paper|live>" >&2; exit 2 ;;
  esac

  echo "=== gateway-control ${action} ${ENVIRONMENT}: $(date -u +%FT%TZ) ==="
  case "$action" in
    fresh-login) fresh_login ;;
    restart-session) restart_session ;;
    *) echo "usage: gateway-control.sh <fresh-login|restart-session> <paper|live>" >&2; exit 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
