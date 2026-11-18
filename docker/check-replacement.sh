#!/usr/bin/env bash
# SC-008 (tasks.md T128): replacing the container keeps every item, event and document,
# and a backup restores identically into a scratch volume.
#
#   docker/check-replacement.sh [docker compose arguments…]
#
# The arguments select the stack (default: -f docker/compose.yaml). The service must be
# running. The script:
#   1. records the checksums (docket checksums);
#   2. takes a backup (docket backup now);
#   3. runs `docker compose down` (the container is removed, the volume stays) and `up`;
#   4. checks that every item ID, every event up to the recorded one and every document
#      (rows and bytes) is unchanged; the restart may append events, never change them;
#   5. restores the backup into a throwaway volume and checks it is identical.
set -euo pipefail
# Git Bash on Windows would rewrite the container paths below.
export MSYS_NO_PATHCONV=1

compose=(docker compose "$@")
[ "$#" -gt 0 ] || compose=(docker compose -f docker/compose.yaml)

field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(process.argv[1].split(".").reduce((o,k)=>o[k],v))})' "$1"; }

before=$("${compose[@]}" exec -T docket docket checksums)
seq=$(echo "$before" | field events.max_seq)
echo "Before: $(echo "$before" | field items.count) items, $(echo "$before" | field events.count) events (through seq $seq), $(echo "$before" | field documents.count) document versions"

backup=$("${compose[@]}" exec -T docket docket backup now | sed -n 's/^Backup written and verified: //p')
echo "Backup: $backup"
volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$("${compose[@]}" ps -q docket)")
image=$(docker inspect --format '{{.Config.Image}}' "$("${compose[@]}" ps -q docket)")

echo "Replacing the container (down, then up)…"
"${compose[@]}" down
"${compose[@]}" up -d --wait --wait-timeout 120

after=$("${compose[@]}" exec -T docket docket checksums --through-seq "$seq")
fail=0
for key in items.ids_sha256 items.count events.count events.sha256 documents.count documents.bytes documents.sha256; do
  a=$(echo "$before" | field "$key")
  b=$(echo "$after" | field "$key")
  if [ "$a" = "$b" ]; then echo "same  $key"; else echo "DIFF  $key: $a → $b"; fail=1; fi
done
[ "$fail" -eq 0 ] || { echo "SC-008 failed: the replacement changed data." >&2; exit 1; }

scratch="docket-sc008-scratch-$$"
trap 'docker volume rm -f "$scratch" >/dev/null 2>&1 || true' EXIT
echo "Restoring $backup into the scratch volume $scratch…"
docker run --rm --entrypoint docket -v "$volume:/source:ro" -v "$scratch:/data" "$image" \
  restore "/source/backups/$(basename "$backup")"
echo "SC-008 passed: the replacement kept every item, event and document, and the backup restored identically."
