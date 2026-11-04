#!/bin/bash
# One-off VPS setup: authorizes the health checks' data-reconnect keys, each bound by a forced command to
# `gateway-control.sh reconnect-data <environment>` (IBC's RECONNECTDATA: no restart, no API disconnect), so the
# caller can never choose another action or environment. One key per environment, never shared: the staging health
# check holds the paper key, the prod health check the live key. Backs up authorized_keys first; safe to re-run.
#
# Usage: install-gateway-reconnect-data-keys.sh "<paper public key>" "<live public key>"
set -euo pipefail

readonly authorized_keys_file="${AUTHORIZED_KEYS_FILE:-/root/.ssh/authorized_keys}"
readonly paper_public_key="${1:?paper public key}"
readonly live_public_key="${2:?live public key}"
readonly key_options="no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc"

if [[ "$(echo "$paper_public_key" | awk '{print $2}')" == "$(echo "$live_public_key" | awk '{print $2}')" ]]; then
  echo "the paper and live keys must differ" >&2
  exit 1
fi

cp "$authorized_keys_file" "${authorized_keys_file}.bak-$(date +%s)"

authorize() {
  local environment="$1" public_key="$2" key_body
  key_body=$(echo "$public_key" | awk '{print $2}')
  if grep -qF "$key_body" "$authorized_keys_file"; then
    echo "${environment}: key already present, left as it is"
  else
    echo "command=\"/opt/ibkr/gateway-control.sh reconnect-data ${environment}\",${key_options} ${public_key}" >> "$authorized_keys_file"
    echo "${environment}: key added"
  fi
}

authorize paper "$paper_public_key"
authorize live "$live_public_key"

echo "gateway-control reconnect-data keys:"
grep 'command="/opt/ibkr/gateway-control.sh reconnect-data ' "$authorized_keys_file" | awk '{ split($0, quoted, "\""); print "  " quoted[2] "  <-  " $NF }'
