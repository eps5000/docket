#!/usr/bin/env bash
# FR-106 guard (tasks.md T145), after the e2e suite ran against the sealed stack:
#
#   docker/no-egress/check.sh [docker compose arguments…]
#
# The arguments select the stack, the no-egress overlay included. It checks that:
#   1. the tasklite container is attached to exactly one network, and it is internal;
#   2. the egress audit recorded nothing: no Node process in the container tried to
#      reach a host other than itself and the Jira fixture during the whole run;
#   3. the audit works: a deliberate probe from inside the container (a fetch to a
#      public site, and a TCP connect to a public address) is recorded, and fails.
set -euo pipefail
export MSYS_NO_PATHCONV=1

compose=(docker compose "$@")
[ "$#" -gt 0 ] || { echo "Pass the compose arguments, the no-egress overlay included." >&2; exit 2; }

id=$("${compose[@]}" ps -q tasklite)
nets=$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$id")
count=$(echo "$nets" | wc -w | tr -d ' ')
[ "$count" -eq 1 ] || { echo "FAIL: tasklite is on $count networks ($nets); expected only the sealed one." >&2; exit 1; }
internal=$(docker network inspect --format '{{.Internal}}' $nets)
[ "$internal" = "true" ] || { echo "FAIL: tasklite's network $nets is not internal." >&2; exit 1; }
echo "ok    tasklite is only on $nets (internal: no route out)"

audit=$("${compose[@]}" exec -T tasklite sh -c 'cat /data/egress-audit.jsonl 2>/dev/null || true')
if [ -n "$audit" ]; then
  echo "FAIL: outbound connection attempts were recorded during the run:" >&2
  echo "$audit" >&2
  exit 1
fi
echo "ok    no outbound connection attempts recorded during the run"

# The deliberate probe, with its own log so it never pollutes the run's.
probe=$("${compose[@]}" exec -T -e TASKLITE_EGRESS_LOG=/tmp/egress-probe.jsonl tasklite node -e '
  const net = require("node:net");
  const tcp = new Promise((done) => {
    const s = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
    s.on("connect", () => { s.destroy(); done("REACHED"); });
    s.on("timeout", () => { s.destroy(); done("timeout"); });
    s.on("error", (e) => done(e.code));
  });
  const web = fetch("https://example.com/", { signal: AbortSignal.timeout(5000) })
    .then(() => "REACHED", (e) => (e.cause && e.cause.code) || e.name);
  Promise.all([tcp, web]).then(([a, b]) => console.log(`tcp=${a} fetch=${b}`));
')
recorded=$("${compose[@]}" exec -T tasklite sh -c 'cat /tmp/egress-probe.jsonl 2>/dev/null; rm -f /tmp/egress-probe.jsonl')
echo "probe: $probe"
echo "$recorded" | sed 's/^/probe recorded: /'
case "$probe" in *REACHED*) echo "FAIL: the probe reached the internet; the network isn't sealed." >&2; exit 1 ;; esac
echo "$recorded" | grep -q '"host":"1.1.1.1"' || { echo "FAIL: the audit missed the TCP probe." >&2; exit 1; }
echo "$recorded" | grep -q '"host":"example.com"' || { echo "FAIL: the audit missed the fetch probe." >&2; exit 1; }
echo "ok    a deliberate outbound attempt is caught by the audit, and fails"
echo "FR-106 no-egress check passed."
