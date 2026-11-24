#!/usr/bin/env bash
# After `docker compose up --wait` on the sealed stack (docker/compose.no-egress.yaml):
# wait until the browser's way in works end to end, 127.0.0.1:7420 → gateway → docket,
# with docket ready (/readyz: database, migrations, data folder), not just its process up.
#
#   docker/no-egress/wait-ready.sh [url] [seconds]
#
# Defaults: http://127.0.0.1:7420/readyz, 120 seconds. Exits 1 with the last answer if it
# never becomes ready.
set -euo pipefail

url="${1:-http://127.0.0.1:7420/readyz}"
limit="${2:-120}"
end=$((SECONDS + limit))
last=""
while true; do
  if last=$(curl -sS --max-time 5 -w ' (HTTP %{http_code})' "$url" 2>&1) && [[ "$last" == *"(HTTP 200)" ]]; then
    echo "Ready through the gateway: $url"
    exit 0
  fi
  if ((SECONDS >= end)); then
    echo "Docket isn't ready through the gateway at $url after ${limit}s. Last answer: $last" >&2
    exit 1
  fi
  sleep 1
done
