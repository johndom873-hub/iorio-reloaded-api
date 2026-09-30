#!/bin/bash
# One-off VPS setup: points the health-check SSH keys at `gateway-control.sh recover <environment>`
# (session-preserving restart; see gateway-control.sh) instead of the old unconditional restart-gateway.sh,
# and authorizes a new key bound to `recover live` for the prod health check.
#
# Keys that run restart-gateway.sh today (paper Gateway, cold restart) become `recover paper`:
# the staging health-check key and the original one. The new live key is appended, never reused
# for paper. Backs up authorized_keys first; safe to re-run.
set -euo pipefail

readonly authorized_keys_file="${AUTHORIZED_KEYS_FILE:-/root/.ssh/authorized_keys}"
readonly live_recover_public_key="$1"   # "ssh-ed25519 AAAA... iorio-live-gateway-recover"
readonly key_options="no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc"

cp "$authorized_keys_file" "${authorized_keys_file}.bak-$(date +%s)"

sed -i 's#^command="/opt/ibkr/restart-gateway.sh"#command="/opt/ibkr/gateway-control.sh recover paper"#' "$authorized_keys_file"

live_recover_key_body=$(echo "$live_recover_public_key" | awk '{print $2}')
if ! grep -qF "$live_recover_key_body" "$authorized_keys_file"; then
  echo "command=\"/opt/ibkr/gateway-control.sh recover live\",${key_options} ${live_recover_public_key}" >> "$authorized_keys_file"
fi

echo "gateway-control recover keys:"
grep 'command="/opt/ibkr/gateway-control.sh recover ' "$authorized_keys_file" | awk '{ split($0, quoted, "\""); print "  " quoted[2] "  <-  " $NF }'
echo "remaining restart-gateway.sh entries: $(grep -c 'command="/opt/ibkr/restart-gateway.sh"' "$authorized_keys_file" || true)"
