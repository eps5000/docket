/**
 * The installed `docket-wait` script (owner decision 40; BUILD_SPEC §5.11):
 * `docket-wait.sh` (bash, with curl) and `docket-wait.ps1` (PowerShell 5.1
 * and 7), next to `docket-check`, in the manifest and covered by *Check* and
 * drift.
 *
 * It blocks on `GET /agent/changes/wait`, so a waiting agent spends no model
 * tokens until something relevant changes, and it retries through a Docket
 * restart. It prints one compact result, the status with the new cursor and
 * one line per event, and exits 0 (changed), 2 (timed out) or 1 (error).
 *
 * The address comes from `--url`, `DOCKET_URL`, the install's connection file,
 * or the default. In protected mode it sends `DOCKET_TOKEN`, on stdin so the
 * token never shows in a process list. It reads only. ASCII only, so
 * PowerShell 5.1 reads it the same in any code page.
 */
export const WAIT_EXIT = { changed: 0, error: 1, timeout: 2 } as const;

export function waitSh(): string {
  return `#!/usr/bin/env bash
# Docket docket-wait. Blocks until a matching change, costing no model tokens, then
# prints the new cursor and one line per event. It survives a Docket restart.
# Usage: docket-wait.sh [--cursor N] [--project KEY] [--item ID] [--types a,b]
#                       [--timeout SECONDS] [--url URL]
# Exit: 0 changed, 2 timed out (prints the cursor to pass next), 1 error.
export LC_ALL=C
cursor=''; project=''; item=''; types=''; timeout=300; url="\${DOCKET_URL:-}"
fail() { echo "docket-wait: $1" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case $1 in -h|--help) sed -n '2,6p' "$0" | cut -c3-; exit 0 ;; esac
  [ $# -ge 2 ] || fail "$1 needs a value"
  case $1 in
    --cursor) cursor=$2 ;;
    --project) project=$2 ;;
    --item) item=$2 ;;
    --types) types=$2 ;;
    --timeout) timeout=$2 ;;
    --url) url=$2 ;;
    *) fail "unknown option $1" ;;
  esac
  shift 2
done
case $timeout in ''|*[!0-9]*) fail '--timeout must be a whole number of seconds' ;; esac
case $cursor in *[!0-9]*) fail '--cursor must be a number' ;; esac
command -v curl > /dev/null 2>&1 || fail 'curl is required'
if [ -z "$url" ]; then
  here=$(cd "$(dirname "$0")" && pwd); base=$(dirname "$here")
  for f in "$base/.mcp.json" "$here/config.toml"; do
    [ -f "$f" ] || continue
    u=$(grep -A6 'docket' "$f" | grep -Eo 'https?://[^"[:space:]]+/mcp' | head -n 1)
    if [ -n "$u" ]; then url=$u; break; fi
  done
fi
url=\${url:-http://127.0.0.1:7420}; url=\${url%/}; url=\${url%/mcp}
q=(--data-urlencode format=text)
[ -n "$project" ] && q+=(--data-urlencode "project=$project")
[ -n "$item" ] && q+=(--data-urlencode "item_id=$item")
[ -n "$types" ] && q+=(--data-urlencode "types=$types")
hdr=(); [ -n "\${DOCKET_TOKEN:-}" ] && hdr=(-H @-)
nl=$'\\n'
ask() { # seconds to hold; sets code and body
  local c=() o
  [ -n "$cursor" ] && c=(--data-urlencode "cursor=$cursor")
  o=$(printf 'Authorization: Bearer %s\\n' "\${DOCKET_TOKEN:-}" | curl -sS --noproxy '*' --connect-timeout 5 --max-time $(($1 + 15)) -G -w "$nl%{http_code}" "\${hdr[@]}" "\${q[@]}" "\${c[@]}" --data-urlencode "timeout_s=$1" "$url/agent/changes/wait" 2> /dev/null) || o="$nl"000
  code=\${o##*"$nl"}; body=\${o%"$nl"*}
}
deadline=$(($(date +%s) + timeout)); delay=1
while :; do
  left=$((deadline - $(date +%s))); [ "$left" -lt 0 ] && left=0
  hold=$left; [ "$hold" -gt 240 ] && hold=240
  had=$cursor; [ -z "$had" ] && hold=0
  ask "$hold"
  case $code in
    200)
      delay=1
      first=\${body%%"$nl"*}
      case $first in
        changed\\ *) printf '%s\\n' "$body"; exit 0 ;;
        timeout\\ *)
          n=\${first#*cursor=}; cursor=\${n%% *}
          if [ -n "$had" ] && [ "$left" -le "$hold" ]; then printf 'timeout cursor=%s events=0\\n' "$cursor"; exit 2; fi
          ;;
        *) fail "unexpected answer from $url" ;;
      esac
      ;;
    400|401|403|404|421) fail "Docket refused the wait ($code): $body" ;;
    *)
      # Docket is down or restarting: keep trying until the deadline.
      [ "$(date +%s)" -lt "$deadline" ] || fail "Docket at $url did not answer before the timeout"
      sleep "$delay"; delay=$((delay * 2)); [ "$delay" -gt 5 ] && delay=5
      ;;
  esac
done
`;
}

export function waitPs1(): string {
  return `# Docket docket-wait. Blocks until a matching change, costing no model tokens, then
# prints the new cursor and one line per event. It survives a Docket restart.
# Usage: docket-wait.ps1 [--cursor N] [--project KEY] [--item ID] [--types a,b]
#                        [--timeout SECONDS] [--url URL]
# Exit: 0 changed, 2 timed out (prints the cursor to pass next), 1 error.
$ErrorActionPreference = 'Stop'
$cursor = ''; $project = ''; $item = ''; $types = ''; $timeout = '300'; $url = "$env:DOCKET_URL"
function Stop-Wait([string]$m) { [Console]::Error.WriteLine("docket-wait: $m"); exit 1 }
for ($a = 0; $a -lt $args.Count; $a += 2) {
  $k = [string]$args[$a]
  if ($k -eq '-h' -or $k -eq '--help') { Get-Content -LiteralPath $PSCommandPath -TotalCount 5 | ForEach-Object { $_.Substring(2) }; exit 0 }
  if ($a + 1 -ge $args.Count) { Stop-Wait "$k needs a value" }
  $v = [string]$args[$a + 1]
  switch -CaseSensitive ($k) {
    '--cursor' { $cursor = $v }
    '--project' { $project = $v }
    '--item' { $item = $v }
    '--types' { $types = $v }
    '--timeout' { $timeout = $v }
    '--url' { $url = $v }
    default { Stop-Wait "unknown option $k" }
  }
}
if ($timeout -notmatch '^[0-9]+$') { Stop-Wait '--timeout must be a whole number of seconds' }
if ($cursor -notmatch '^[0-9]*$') { Stop-Wait '--cursor must be a number' }
if (-not $url) {
  $here = $PSScriptRoot; $base = Split-Path -Parent $here
  foreach ($f in @((Join-Path $base '.mcp.json'), (Join-Path $here 'config.toml'))) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    $lines = [IO.File]::ReadAllLines($f)
    for ($i = 0; $i -lt $lines.Count -and -not $url; $i++) {
      if ($lines[$i] -notmatch 'docket') { continue }
      $end = [Math]::Min($i + 6, $lines.Count - 1)
      $m = [regex]::Match(($lines[$i..$end] -join ' '), 'https?://[^"\\s]+/mcp')
      if ($m.Success) { $url = $m.Value }
    }
    if ($url) { break }
  }
}
if (-not $url) { $url = 'http://127.0.0.1:7420' }
$url = $url.TrimEnd('/'); if ($url.EndsWith('/mcp')) { $url = $url.Substring(0, $url.Length - 4) }
function Read-Body($res) {
  $sr = New-Object IO.StreamReader($res.GetResponseStream(), [Text.Encoding]::UTF8)
  try { return $sr.ReadToEnd() } finally { $sr.Close() }
}
function Invoke-Wait([int]$hold) {
  $q = @('format=text', "timeout_s=$hold")
  if ($script:cursor) { $q += "cursor=$script:cursor" }
  if ($project) { $q += 'project=' + [uri]::EscapeDataString($project) }
  if ($item) { $q += 'item_id=' + [uri]::EscapeDataString($item) }
  if ($types) { $q += 'types=' + [uri]::EscapeDataString($types) }
  $req = [Net.HttpWebRequest]::Create("$url/agent/changes/wait?" + ($q -join '&'))
  $req.Proxy = $null
  $req.Timeout = ($hold + 15) * 1000
  $req.ReadWriteTimeout = ($hold + 15) * 1000
  if ($env:DOCKET_TOKEN) { $req.Headers.Add('Authorization', "Bearer $env:DOCKET_TOKEN") }
  try {
    $res = $req.GetResponse()
    try { return @{ code = [int]$res.StatusCode; body = (Read-Body $res) } } finally { $res.Close() }
  } catch {
    $e = $_.Exception
    while ($e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
    if ($e -and $e.Response) {
      try { return @{ code = [int]$e.Response.StatusCode; body = (Read-Body $e.Response) } } finally { $e.Response.Close() }
    }
    return @{ code = 0; body = '' }
  }
}
$deadline = [DateTime]::UtcNow.AddSeconds([double]$timeout); $delay = 1
while ($true) {
  $left = [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)
  if ($left -lt 0) { $left = 0 }
  $hold = [Math]::Min($left, 240)
  $had = $cursor
  if (-not $had) { $hold = 0 }
  $r = Invoke-Wait $hold
  if ($r.code -eq 200) {
    $delay = 1
    $body = $r.body.TrimEnd()
    $first = ($body -split "\`n")[0]
    if ($first.StartsWith('changed ')) { [Console]::Out.WriteLine($body); exit 0 }
    if (-not $first.StartsWith('timeout ')) { Stop-Wait "unexpected answer from $url" }
    $cursor = ([regex]::Match($first, 'cursor=([0-9]+)')).Groups[1].Value
    if ($had -and $left -le $hold) { [Console]::Out.WriteLine("timeout cursor=$cursor events=0"); exit 2 }
  } elseif (@(400, 401, 403, 404, 421) -contains $r.code) {
    Stop-Wait "Docket refused the wait ($($r.code)): $($r.body)"
  } else {
    # Docket is down or restarting: keep trying until the deadline.
    if ([DateTime]::UtcNow -ge $deadline) { Stop-Wait "Docket at $url did not answer before the timeout" }
    Start-Sleep -Seconds $delay
    $delay = [Math]::Min($delay * 2, 5)
  }
}
`;
}
