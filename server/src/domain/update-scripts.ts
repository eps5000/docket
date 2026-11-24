/**
 * The installed `docket-update` script (owner decision 56; BUILD_SPEC §5.39):
 * `docket-update.sh` (bash, with curl and tar) and `docket-update.ps1`
 * (PowerShell 5.1 and 7), next to `docket-check` and in the manifest.
 *
 * **Docket publishes; the project takes it in.** Run from any checkout, on a
 * branch the agent chose, it:
 * 1. refuses a folder that isn't in a git repo;
 * 2. hashes this checkout's installed files as `docket-check` does, and sends
 *    only those hashes to `POST /agent/update`;
 * 3. unpacks what Docket answers: the files that changed, a plan, and the
 *    normal install step, so layout, marker merge, connection-file and
 *    old-skill rules are the install's own;
 * 4. checks every client before any of them writes;
 * 5. prints exactly what changed.
 *
 * A file edited locally is never overwritten: it's listed as kept, and the
 * manifest keeps what Docket last sent for it, so drift still shows it.
 *
 * It never commits, pushes, opens a PR or touches another worktree, and it
 * writes no credential: protected mode reads `DOCKET_TOKEN` from the
 * environment. Running it again changes nothing. ASCII only, so PowerShell
 * 5.1 reads it the same in any code page.
 *
 * The bash body is one function called from the last line, because the update
 * can replace this very file while it runs. The PowerShell version throws
 * instead of calling `exit`, because the bootstrap runs it as a script block
 * in the caller's own session.
 */
import {
  CONNECTION_AWK_ITEMS,
  CONNECTION_FILES,
  CONNECTION_KEY,
  CONNECTION_PS1,
  DOCKET_BEGIN,
  DOCKET_END,
  INSTALL_MANIFEST_NAME,
  LEGACY_BEGIN,
  LEGACY_END,
  LEGACY_MANIFEST_NAME,
  LEGACY_SKILL_PREFIX,
} from '@docket/shared';

const AWK_LIST = CONNECTION_AWK_ITEMS.map((i) => `'${i}'`).join(' ');

export function updateSh(): string {
  return `#!/usr/bin/env bash
# Docket docket-update. Takes this project's current Docket agent files into this
# checkout, on the branch you are on. It never commits, pushes, opens a PR or
# touches another worktree: commit the result through your normal process.
# Usage: docket-update.sh [--project KEY] [--client claude|codex] [--url URL]
# Exit: 0 updated or already current, 1 error (nothing was written).
export LC_ALL=C
main() {
  local project='' only='' url="\${DOCKET_URL:-}" script=$0
  fail() { echo "docket-update: $1" >&2; exit 1; }
  while [ $# -gt 0 ]; do
    case $1 in -h|--help) sed -n '2,6p' "$script" | cut -c3-; exit 0 ;; esac
    [ $# -ge 2 ] || fail "$1 needs a value"
    case $1 in
      --project) project=$2 ;;
      --client) only=$2 ;;
      --url) url=$2 ;;
      *) fail "unknown option $1" ;;
    esac
    shift 2
  done
  case $only in ''|claude|codex) ;; *) fail '--client must be claude or codex' ;; esac
  case $project in *[!A-Z0-9]*) fail '--project must be a project key like RCP' ;; esac
  for x in git curl tar awk; do command -v "$x" > /dev/null 2>&1 || fail "$x is required"; done
  local root
  root=$(git rev-parse --show-toplevel 2> /dev/null) || root=''
  [ -n "$root" ] || fail "this folder isn't in a git repository. Run it from a checkout of the project's repo. Nothing was written."
  cd "$root" || fail "can't enter $root"

  # Which clients: those installed here, or the one named.
  local clients='' c d m p seen=''
  for c in claude codex; do
    [ -z "$only" ] || [ "$only" = "$c" ] || continue
    d=.$c; m=$d/${INSTALL_MANIFEST_NAME}
    [ -f "$m" ] || m=$d/${LEGACY_MANIFEST_NAME}
    if [ -f "$m" ]; then
      grep -q '"target": *"repo"' "$m" || fail "$m isn't a repo install."
      p=$(sed -n 's/^ *"project": *"\\([A-Z0-9]*\\)",*$/\\1/p' "$m" | head -n 1)
      [ -n "$p" ] || fail "$m names no project. Pass --project KEY."
      if [ -n "$project" ] && [ "$project" != "$p" ]; then fail "this checkout is installed for $p, not $project."; fi
      if [ -n "$seen" ] && [ "$seen" != "$p" ]; then fail "the clients here are installed for different projects ($seen and $p)."; fi
      seen=$p; clients="$clients $c"
    elif [ "$only" = "$c" ]; then
      clients="$clients $c"
    fi
  done
  [ -n "$clients" ] || fail 'no Docket install here. Pass --project KEY and --client claude or codex.'
  project=\${project:-$seen}
  [ -n "$project" ] || fail 'pass --project KEY for a first install.'

  if [ -z "$url" ]; then
    local f u
    for f in .mcp.json .codex/config.toml; do
      [ -f "$f" ] || continue
      u=$(grep -A6 'docket' "$f" | grep -Eo 'https?://[^"[:space:]]+/mcp' | head -n 1)
      if [ -n "$u" ]; then url=$u; break; fi
    done
  fi
  url=\${url:-http://127.0.0.1:7420}; url=\${url%/}; url=\${url%/mcp}

  tmp=$(mktemp -d) || fail "can't make a temporary folder"
  trap 'rm -rf "$tmp"' EXIT
  local A; A=$(printf '%s\\n' ${AWK_LIST})
  local B='${DOCKET_BEGIN}' E='${DOCKET_END}' OB='${LEGACY_BEGIN}' OE='${LEGACY_END}'
  h() { tr -d '\\r' | { sha256sum 2> /dev/null || shasum -a 256; } | cut -c1-64; }

  # The local hash of one key; empty when the file or its section isn't there.
  local_hash() { # key client
    local k=$1 cl=$2 f x mb me
    case $k in
      agents_block)
        if [ "$cl" = claude ]; then f=CLAUDE.md; else f=AGENTS.md; fi
        [ -f "$f" ] || return 0
        x=$(cat "$f"; printf x); x=\${x%x}
        mb=$B; me=$E
        case $x in *"$B"*) ;; *) mb=$OB; me=$OE ;; esac
        case $x in *"$mb"*"$me"*) ;; *) return 0 ;; esac
        x=\${x#*"$mb"}; x=\${x%%"$me"*}; x=$(printf '%s' "$x" | tr -d '\\r'; printf x); x=\${x%x}; x=\${x#$'\\n'}; x=\${x%$'\\n'}
        printf '%s' "$x" | h ;;
      ${CONNECTION_KEY})
        if [ "$cl" = claude ]; then f=${CONNECTION_FILES.claude}; x=json; else f=${CONNECTION_FILES.codex}; x=toml; fi
        [ -f "$f" ] || return 0
        x=$(awk -v mode=$x -v out=canon "$A" "$f")
        case $x in '!absent') return 0 ;; '!invalid') printf '%064d' 0; return 0 ;; esac
        printf '%s' "$x" | h ;;
      skill:*) f=.$cl/skills/\${k#skill:}/SKILL.md; [ -f "$f" ] && h < "$f" ;;
      script:*) f=.$cl/\${k#script:}; [ -f "$f" ] && h < "$f" ;;
    esac
    return 0
  }

  # One request per client: what is here, and what the manifest says was sent.
  local from body l k v s got n listed code msg hdr
  for c in $clients; do
    d=.$c; m=$d/${INSTALL_MANIFEST_NAME}
    [ -f "$m" ] || m=$d/${LEGACY_MANIFEST_NAME}
    from=''; body=''; listed=' '
    if [ -f "$m" ]; then
      from=$(grep -o 'ins_[0-9A-Za-z]*' "$m" | head -n 1)
      while IFS= read -r l; do
        case $l in *'"key":"'*) ;; *) continue ;; esac
        k=\${l#*'"key":"'}; k=\${k%%'"'*}; v=\${l#*'"version_id":"'}; v=\${v%%'"'*}; s=\${l#*'"sha256":"'}; s=\${s%%'"'*}
        case $k in skill:${LEGACY_SKILL_PREFIX}*) continue ;; esac
        case $k in agents_block|${CONNECTION_KEY}|skill:*|script:*) ;; *) continue ;; esac
        case $k$v in *[!A-Za-z0-9:._-]*) continue ;; esac
        case $s in *[!0-9a-fA-F]*|'') continue ;; esac
        listed="$listed$k "
        got=$(local_hash "$k" "$c")
        if [ -n "$got" ]; then
          body="$body\${body:+,}{\\"key\\":\\"$k\\",\\"sha256\\":\\"$got\\",\\"sent\\":\\"$s\\",\\"version_id\\":\\"$v\\"}"
        fi
      done < "$m"
    fi
    # What's here that the manifest doesn't list can't be overwritten blindly.
    for k in agents_block ${CONNECTION_KEY} script:docket-check.sh script:docket-check.ps1 script:docket-wait.sh script:docket-wait.ps1 script:docket-update.sh script:docket-update.ps1; do
      case $listed in *" $k "*) continue ;; esac
      got=$(local_hash "$k" "$c")
      if [ -n "$got" ]; then body="$body\${body:+,}{\\"key\\":\\"$k\\",\\"sha256\\":\\"$got\\"}"; fi
    done
    for x in "$d"/skills/docket-*/; do
      [ -f "\${x}SKILL.md" ] || continue
      n=\${x%/}; n=\${n##*/}
      case $n in *[!a-z0-9-]*) continue ;; esac
      case $listed in *" skill:$n "*) continue ;; esac
      body="$body\${body:+,}{\\"key\\":\\"skill:$n\\",\\"sha256\\":\\"$(h < "\${x}SKILL.md")\\"}"
    done
    printf '{"project":"%s","client":"%s"%s,"files":[%s]}' "$project" "$c" "\${from:+,\\"from\\":\\"$from\\"}" "$body" > "$tmp/$c.json"
    hdr=(); [ -n "\${DOCKET_TOKEN:-}" ] && hdr=(-H @-)
    code=$(printf 'Authorization: Bearer %s\\n' "\${DOCKET_TOKEN:-}" | curl -sS --noproxy '*' --connect-timeout 5 --max-time 60 -o "$tmp/$c.tgz" -w '%{http_code}' "\${hdr[@]}" -H 'Content-Type: application/json' --data-binary @"$tmp/$c.json" "$url/agent/update" 2> /dev/null) || code=000
    case $code in
      200) ;;
      000) fail "Docket isn't reachable at $url. Start it, or pass --url. Nothing was written." ;;
      401) fail "Docket is in protected mode and refused the request. Set the DOCKET_TOKEN environment variable, then run this again. Nothing was written." ;;
      *)
        msg=$(sed -n 's/.*"message":"\\([^"]*\\)".*/\\1/p' "$tmp/$c.tgz" | head -n 1)
        fail "Docket refused the update ($code): \${msg:-no details}. Nothing was written." ;;
    esac
    mkdir -p "$tmp/$c"
    tar -xzf "$tmp/$c.tgz" -C "$tmp/$c" || fail "couldn't unpack Docket's answer. Nothing was written."
  done

  # Every client is checked before any of them writes.
  for c in $clients; do
    if [ -f "$tmp/$c/docket-update/install.sh" ]; then
      DOCKET_CHECK_ONLY=1 bash "$tmp/$c/docket-update/install.sh" "$root" > /dev/null 2> "$tmp/err" || {
        sed 's/^Docket: //' "$tmp/err" >&2
        fail 'stopped before writing anything. Fix that, then run this again.'
      }
    fi
  done

  # Apply, and say exactly what changed.
  local changed=0 kept=0 label what path note
  for c in $clients; do
    if [ "$c" = claude ]; then label='Claude Code'; else label=Codex; fi
    if [ -f "$tmp/$c/docket-update/install.sh" ]; then
      bash "$tmp/$c/docket-update/install.sh" "$root" > "$tmp/$c.log" 2>&1 || {
        cat "$tmp/$c.log" >&2
        fail "$label: the install step failed part way. Check 'git status' in $root."
      }
    fi
    n=0
    while IFS="$(printf '\\t')" read -r what path note; do
      case $what in
        added|updated) n=$((n + 1)); changed=$((changed + 1)) ;;
        kept) kept=$((kept + 1)) ;;
      esac
    done < "$tmp/$c/docket-update/plan.txt"
    if [ "$n" = 0 ]; then echo "$label: already current."; else echo "$label: $n file(s) changed."; fi
    while IFS="$(printf '\\t')" read -r what path note; do
      [ "$what" = same ] && continue
      printf '  %-8s %s%s\\n' "$what" "$path" "\${note:+ ($note)}"
    done < "$tmp/$c/docket-update/plan.txt"
    if [ -f "$tmp/$c.log" ]; then grep -E '^  (removed|kept|left) ' "$tmp/$c.log" || true; fi
  done
  if [ "$kept" -gt 0 ]; then
    echo "Kept $kept file(s) edited locally. The owner can Adopt, Restore or Keep local in Docket's Agent files."
  fi
  if [ "$changed" -gt 0 ]; then
    echo 'Nothing was committed or pushed. Commit these files through your normal process.'
  fi
}
main "$@"; exit $?
`;
}

export function updatePs1(): string {
  return `# Docket docket-update. Takes this project's current Docket agent files into this
# checkout, on the branch you are on. It never commits, pushes, opens a PR or
# touches another worktree: commit the result through your normal process.
# Usage: docket-update.ps1 [--project KEY] [--client claude|codex] [--url URL]
# Errors stop it before anything is written.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$project = ''; $only = ''; $url = "$env:DOCKET_URL"
function Stop-Update([string]$m) { throw "docket-update: $m" }
for ($a = 0; $a -lt $args.Count; $a += 2) {
  $k = [string]$args[$a]
  if ($a + 1 -ge $args.Count) { Stop-Update "$k needs a value" }
  $v = [string]$args[$a + 1]
  switch -CaseSensitive ($k) {
    '--project' { $project = $v }
    '--client' { $only = $v }
    '--url' { $url = $v }
    default { Stop-Update "unknown option $k" }
  }
}
if ($only -and @('claude', 'codex') -cnotcontains $only) { Stop-Update '--client must be claude or codex' }
if ($project -cnotmatch '^[A-Z0-9]*$') { Stop-Update '--project must be a project key like RCP' }
foreach ($x in @('git', 'tar')) {
  if (-not (Get-Command $x -ErrorAction SilentlyContinue)) { Stop-Update "$x is required" }
}
$prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$root = & git rev-parse --show-toplevel 2>$null
$gitExit = $LASTEXITCODE; $ErrorActionPreference = $prevEap
if ($root -is [array]) { $root = $root[0] }
if ($gitExit -ne 0 -or -not $root) { Stop-Update "this folder isn't in a git repository. Run it from a checkout of the project's repo. Nothing was written." }
$root = (Resolve-Path -LiteralPath ([string]$root)).ProviderPath
$enc = [Text.Encoding]::GetEncoding(28591)
$utf8 = New-Object Text.UTF8Encoding $false
$ord = [StringComparison]::Ordinal
$sha = [Security.Cryptography.SHA256]::Create()
$B = '${DOCKET_BEGIN}'; $E = '${DOCKET_END}'; $OB = '${LEGACY_BEGIN}'; $OE = '${LEGACY_END}'
${CONNECTION_PS1}
function Get-DkHash([string]$s) { -join ($sha.ComputeHash($enc.GetBytes($s.Replace("\`r", ''))) | ForEach-Object { $_.ToString('x2') }) }
function Read-DkBytes([string]$f) { $enc.GetString([IO.File]::ReadAllBytes($f)) }
function Get-DkManifest([string]$c) {
  $d = Join-Path $root ".$c"
  foreach ($n in @('${INSTALL_MANIFEST_NAME}', '${LEGACY_MANIFEST_NAME}')) {
    $m = Join-Path $d $n
    if (Test-Path -LiteralPath $m -PathType Leaf) { return $m }
  }
  return $null
}
function Get-LocalHash([string]$k, [string]$c) {
  if ($k -ceq 'agents_block') {
    $n = 'AGENTS.md'; if ($c -ceq 'claude') { $n = 'CLAUDE.md' }
    $f = Join-Path $root $n
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
    $x = (Read-DkBytes $f).Replace("\`r", '')
    $mb = $B; $me = $E
    if ($x.IndexOf($B, $ord) -lt 0) { $mb = $OB; $me = $OE }
    $i = $x.IndexOf($mb, $ord); $j = $x.IndexOf($me, $ord)
    if ($i -lt 0 -or $j -lt $i) { return $null }
    $x = $x.Substring($i + $mb.Length, $j - $i - $mb.Length)
    if ($x.StartsWith("\`n", $ord)) { $x = $x.Substring(1) }
    if ($x.EndsWith("\`n", $ord)) { $x = $x.Substring(0, $x.Length - 1) }
    return (Get-DkHash $x)
  }
  if ($k -ceq '${CONNECTION_KEY}') {
    $n = '${CONNECTION_FILES.codex}'; if ($c -ceq 'claude') { $n = '${CONNECTION_FILES.claude}' }
    $f = Join-Path $root $n
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
    $x = DkCanon $c (Read-DkBytes $f)
    if ($null -eq $x) { return $null }
    if ($x -ceq '!invalid') { return ('0' * 64) }
    return (Get-DkHash $x)
  }
  if ($k.StartsWith('skill:', $ord)) { $f = Join-Path $root (".$c/skills/" + $k.Substring(6) + '/SKILL.md') }
  elseif ($k.StartsWith('script:', $ord)) { $f = Join-Path $root (".$c/" + $k.Substring(7)) }
  else { return $null }
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  return (Get-DkHash (Read-DkBytes $f))
}

$clients = @(); $seen = ''
foreach ($c in @('claude', 'codex')) {
  if ($only -and $only -cne $c) { continue }
  $m = Get-DkManifest $c
  if ($m) {
    $j = [IO.File]::ReadAllText($m) | ConvertFrom-Json
    if ([string]$j.target -cne 'repo') { Stop-Update "$m isn't a repo install." }
    $p = [string]$j.project
    if (-not $p) { Stop-Update "$m names no project. Pass --project KEY." }
    if ($project -and $project -cne $p) { Stop-Update "this checkout is installed for $p, not $project." }
    if ($seen -and $seen -cne $p) { Stop-Update "the clients here are installed for different projects ($seen and $p)." }
    $seen = $p; $clients += $c
  } elseif ($only -ceq $c) { $clients += $c }
}
if ($clients.Count -eq 0) { Stop-Update 'no Docket install here. Pass --project KEY and --client claude or codex.' }
if (-not $project) { $project = $seen }
if (-not $project) { Stop-Update 'pass --project KEY for a first install.' }

if (-not $url) {
  foreach ($f in @((Join-Path $root '.mcp.json'), (Join-Path $root '.codex/config.toml'))) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    $lines = [IO.File]::ReadAllLines($f)
    for ($i = 0; $i -lt $lines.Count -and -not $url; $i++) {
      if ($lines[$i] -notmatch 'docket') { continue }
      $end = [Math]::Min($i + 6, $lines.Count - 1)
      $hit = [regex]::Match(($lines[$i..$end] -join ' '), 'https?://[^"\\s]+/mcp')
      if ($hit.Success) { $url = $hit.Value }
    }
    if ($url) { break }
  }
}
if (-not $url) { $url = 'http://127.0.0.1:7420' }
$url = $url.TrimEnd('/'); if ($url.EndsWith('/mcp')) { $url = $url.Substring(0, $url.Length - 4) }

function Invoke-Update([string]$json, [string]$out) {
  $req = [Net.HttpWebRequest]::Create("$url/agent/update")
  $req.Method = 'POST'; $req.ContentType = 'application/json'; $req.Proxy = $null
  $req.Timeout = 60000; $req.ReadWriteTimeout = 60000
  if ($env:DOCKET_TOKEN) { $req.Headers.Add('Authorization', "Bearer $env:DOCKET_TOKEN") }
  $bytes = $utf8.GetBytes($json)
  try {
    $st = $req.GetRequestStream(); try { $st.Write($bytes, 0, $bytes.Length) } finally { $st.Close() }
    $res = $req.GetResponse()
    try {
      $fs = [IO.File]::Create($out)
      try { $res.GetResponseStream().CopyTo($fs) } finally { $fs.Close() }
    } finally { $res.Close() }
    return @{ code = 200; body = '' }
  } catch {
    $e = $_.Exception
    while ($e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
    if ($e -and $e.Response) {
      $sr = New-Object IO.StreamReader($e.Response.GetResponseStream(), [Text.Encoding]::UTF8)
      try { return @{ code = [int]$e.Response.StatusCode; body = $sr.ReadToEnd() } } finally { $sr.Close(); $e.Response.Close() }
    }
    return @{ code = 0; body = '' }
  }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('docket-update-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $tar = 'tar'
  if ($env:SystemRoot) { $w = Join-Path $env:SystemRoot 'System32/tar.exe'; if (Test-Path -LiteralPath $w) { $tar = $w } }
  $steps = @{}
  foreach ($c in $clients) {
    $files = New-Object System.Collections.ArrayList
    $listed = @{}
    $from = $null
    $m = Get-DkManifest $c
    if ($m) {
      $j = [IO.File]::ReadAllText($m) | ConvertFrom-Json
      if ([string]$j.install_id -cmatch '^ins_[0-9A-Za-z]+$') { $from = [string]$j.install_id }
      foreach ($r in @($j.files)) {
        $k = [string]$r.key; $v = [string]$r.version_id; $s = [string]$r.sha256
        if ($k.StartsWith('skill:${LEGACY_SKILL_PREFIX}', $ord)) { continue }
        if ($k -cnotmatch '^(agents_block|${CONNECTION_KEY}|skill:[a-z0-9-]+|script:[A-Za-z0-9._-]+)$') { continue }
        if ($v -cnotmatch '^[A-Za-z0-9:._-]+$' -or $s -cnotmatch '^[0-9a-fA-F]{64}$') { continue }
        $listed[$k] = $true
        $got = Get-LocalHash $k $c
        if ($got) { [void]$files.Add([ordered]@{ key = $k; sha256 = $got; sent = $s; version_id = $v }) }
      }
    }
    foreach ($k in @('agents_block', '${CONNECTION_KEY}', 'script:docket-check.sh', 'script:docket-check.ps1', 'script:docket-wait.sh', 'script:docket-wait.ps1', 'script:docket-update.sh', 'script:docket-update.ps1')) {
      if ($listed.ContainsKey($k)) { continue }
      $got = Get-LocalHash $k $c
      if ($got) { [void]$files.Add([ordered]@{ key = $k; sha256 = $got }) }
    }
    $sk = Join-Path $root ".$c/skills"
    if (Test-Path -LiteralPath $sk) {
      foreach ($x in @(Get-ChildItem -LiteralPath $sk -Directory -Force -Filter 'docket-*')) {
        if ($x.Name -cnotmatch '^[a-z0-9-]{1,60}$' -or $listed.ContainsKey('skill:' + $x.Name)) { continue }
        $got = Get-LocalHash ('skill:' + $x.Name) $c
        if ($got) { [void]$files.Add([ordered]@{ key = 'skill:' + $x.Name; sha256 = $got }) }
      }
    }
    $o = [ordered]@{ project = $project; client = $c }
    if ($from) { $o.from = $from }
    $o.files = @($files)
    $json = ConvertTo-Json -InputObject $o -Depth 4 -Compress
    $tgz = Join-Path $tmp "$c.tgz"
    $r = Invoke-Update $json $tgz
    if ($r.code -eq 0) { Stop-Update "Docket isn't reachable at $url. Start it, or pass --url. Nothing was written." }
    if ($r.code -eq 401) { Stop-Update 'Docket is in protected mode and refused the request. Set the DOCKET_TOKEN environment variable, then run this again. Nothing was written.' }
    if ($r.code -ne 200) {
      $msg = ([regex]::Match($r.body, '"message":"([^"]*)"')).Groups[1].Value
      if (-not $msg) { $msg = 'no details' }
      Stop-Update "Docket refused the update ($($r.code)): $msg. Nothing was written."
    }
    $to = Join-Path $tmp $c
    New-Item -ItemType Directory -Path $to | Out-Null
    & $tar -xzf $tgz -C $to
    if ($LASTEXITCODE) { Stop-Update "couldn't unpack Docket's answer. Nothing was written." }
    $here = Join-Path $to 'docket-update'
    $i = Join-Path $here 'install.ps1'
    $sb = $null
    if (Test-Path -LiteralPath $i -PathType Leaf) { $sb = [scriptblock]::Create((Get-Content -Raw -LiteralPath $i)) }
    $steps[$c] = @{ here = $here; run = $sb }
  }

  # Every client is checked before any of them writes.
  foreach ($c in $clients) {
    $s = $steps[$c]
    if ($s.run) {
      try { & $s.run $s.here $root 'check' | Out-Null }
      catch { Stop-Update ("$($_.Exception.Message -replace '^Docket: ', '') Stopped before writing anything. Fix that, then run this again.") }
    }
  }

  # Apply, and say exactly what changed.
  $changed = 0; $kept = 0
  foreach ($c in $clients) {
    $s = $steps[$c]
    $label = 'Codex'; if ($c -ceq 'claude') { $label = 'Claude Code' }
    $log = @()
    if ($s.run) {
      try { $log = @(& $s.run $s.here $root) }
      catch { Stop-Update "$($label): the install step failed part way: $($_.Exception.Message) Check 'git status' in $root." }
    }
    $plan = @([IO.File]::ReadAllLines((Join-Path $s.here 'plan.txt')) | Where-Object { $_ })
    $n = 0
    foreach ($l in $plan) {
      $w = $l.Split("\`t")[0]
      if ($w -ceq 'added' -or $w -ceq 'updated') { $n++; $changed++ }
      elseif ($w -ceq 'kept') { $kept++ }
    }
    if ($n -eq 0) { "$($label): already current." } else { "$($label): $n file(s) changed." }
    foreach ($l in $plan) {
      $p = $l.Split("\`t")
      if ($p[0] -ceq 'same') { continue }
      $note = ''; if ($p.Count -gt 2 -and $p[2]) { $note = " ($($p[2]))" }
      '  {0,-8} {1}{2}' -f $p[0], $p[1], $note
    }
    foreach ($x in $log) { if ([string]$x -cmatch '^  (removed|kept|left) ') { [string]$x } }
  }
  if ($kept -gt 0) { "Kept $kept file(s) edited locally. The owner can Adopt, Restore or Keep local in Docket's Agent files." }
  if ($changed -gt 0) { 'Nothing was committed or pushed. Commit these files through your normal process.' }
} finally {
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
`;
}
