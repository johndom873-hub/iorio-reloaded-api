#!/bin/bash
# One-off (re-runnable after an image upgrade) VPS setup: turns on IBC's command server in both Gateway
# containers so gateway-control.sh can send RESTART, which reuses the login session (no 2FA).
#
# It derives /opt/ibkr/ibc-config.ini.tmpl from the image's own template (two lines changed) and mounts it
# over the image's template in docker-compose.yml. It does not create, restart or stop any container: the
# change takes effect when each service is next recreated.
#
# The command server stays inside the container: it listens on 127.0.0.1 only, accepts commands only from
# 127.0.0.1, and no port is published. gateway-control.sh reaches it through `docker exec`.
set -euo pipefail

readonly ibkr_directory=/opt/ibkr
readonly compose_file="${ibkr_directory}/docker-compose.yml"
readonly derived_template="${ibkr_directory}/ibc-config.ini.tmpl"
readonly template_path_in_container=/home/ibgateway/ibc/config.ini.tmpl
readonly image=ghcr.io/gnzsnz/ib-gateway:latest

cd "$ibkr_directory"

container_id=$(docker create "$image")
trap 'docker rm "$container_id" >/dev/null' EXIT
docker cp "${container_id}:${template_path_in_container}" "${derived_template}.new"

sed -i \
  -e 's/^CommandServerPort=.*/CommandServerPort=7462/' \
  -e 's/^ControlFrom=.*/ControlFrom=127.0.0.1/' \
  -e 's/^BindAddress=.*/BindAddress=127.0.0.1/' \
  "${derived_template}.new"

for expected_line in CommandServerPort=7462 ControlFrom=127.0.0.1 BindAddress=127.0.0.1; do
  if [[ $(grep -c "^${expected_line}\$" "${derived_template}.new") -ne 1 ]]; then
    echo "template check failed for ${expected_line}" >&2
    rm -f "${derived_template}.new"
    exit 1
  fi
done
mv "${derived_template}.new" "$derived_template"
chmod 644 "$derived_template"

mount_line="      - ./ibc-config.ini.tmpl:${template_path_in_container}:ro"
if grep -qF "$mount_line" "$compose_file"; then
  echo "compose already mounts the derived template"
else
  cp "$compose_file" "${compose_file}.bak.$(date +%Y%m%d%H%M%S)"
  python3 - "$compose_file" "$mount_line" <<'PY'
import re, sys
path, mount_line = sys.argv[1], sys.argv[2]
text = open(path).read()
text, replacements = re.subn(r"(\n      - \./jts-data(?:-live)?:/home/ibgateway/Jts\n)", lambda m: m.group(1) + mount_line + "\n", text)
if replacements != 2:
    sys.exit(f"expected 2 Jts volume lines, found {replacements}; compose file left untouched")
open(path, "w").write(text)
PY
fi

docker compose config --quiet
echo "derived template: $(grep -E '^(CommandServerPort|ControlFrom|BindAddress)=' "$derived_template" | tr '\n' ' ')"
echo "compose mounts:"
grep -n "ibc-config.ini.tmpl" "$compose_file"
echo "ENABLE_IBC_COMMAND_SERVER_RESULT=ready_to_recreate"
