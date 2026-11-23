/**
 * The uninstall step inside an uninstall command's bundle (owner decision 50;
 * BUILD_SPEC §5.36): `uninstall.sh` (bash) and `uninstall.ps1` (PowerShell
 * 5.1 and 7). The list of files and hashes is written into the script, so what
 * the owner reads in the dialog is everything it will do.
 *
 * Each one:
 * 1. stops, removing nothing, when the manifest there belongs to another
 *    install, when a link leads to it, or when a repo install's folder was
 *    never recorded and has no manifest (the command ran in the wrong folder);
 * 2. removes a listed file only while its content matches the recorded hash.
 *    A modified file is kept and listed;
 * 3. from CLAUDE.md or AGENTS.md removes only the text between the Docket
 *    markers, while it matches the recorded hash, and deletes the file only
 *    if nothing else remains;
 * 4. removes only the `docket` entry of a connection file the install wrote,
 *    while that entry is unchanged;
 * 5. never follows a link, never deletes recursively, and removes a skill
 *    folder only when it's empty;
 * 6. removes the manifest last, and only if nothing was kept, so running it
 *    again picks up where it stopped;
 * 7. prints what it did and reports it to Docket.
 *
 * ASCII only, so PowerShell 5.1 reads it the same in any code page.
 */
import {
  CONNECTION_AWK,
  CONNECTION_PS1,
  DOCKET_BEGIN,
  DOCKET_END,
  INSTALL_MANIFEST_NAME,
  LEGACY_BEGIN,
  LEGACY_END,
  LEGACY_MANIFEST_NAME,
  type InstallClient,
} from '@docket/shared';

/** One thing the step may remove. `script`: Docket's own helper, compared with this version's. */
export interface UninstallEntry {
  kind: 'file' | 'script' | 'block' | 'connection';
  /** Relative to the base, `/`-separated. */
  path: string;
  sha256: string;
}

export interface UninstallPlan {
  install_id: string;
  client: InstallClient;
  /** `.claude` or `.codex`. */
  dir: string;
  /** False for a repo install made without a folder: the base is wherever the command runs. */
  recordedBase: boolean;
  entries: UninstallEntry[];
}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_ID = /^ins_[0-9A-Za-z]+$/;
const SHA = /^[0-9a-f]{64}$/;

function checkPlan(plan: UninstallPlan): void {
  if (!SAFE_ID.test(plan.install_id)) throw new Error('unsafe install id');
  if (!SAFE_PATH.test(plan.dir)) throw new Error('unsafe folder');
  for (const e of plan.entries) {
    if (!SAFE_PATH.test(e.path) || e.path.split('/').some((c) => c === '..' || c === '.')) {
      throw new Error(`unsafe path: ${e.path}`);
    }
    if (!SHA.test(e.sha256)) throw new Error(`bad hash for ${e.path}`);
  }
}

/** The skill folders the plan's files sit in, each once. */
function skillFolders(plan: UninstallPlan): string[] {
  const prefix = `${plan.dir}/skills/`;
  const out = new Set<string>();
  for (const e of plan.entries) {
    if (e.path.startsWith(prefix) && e.path.endsWith('/SKILL.md')) {
      out.add(e.path.slice(0, -'/SKILL.md'.length));
    }
  }
  return [...out];
}

export function uninstallSh(plan: UninstallPlan): string {
  checkPlan(plan);
  const mode = plan.client === 'claude' ? 'json' : 'toml';
  const entries = plan.entries.map((e) => `${e.kind}|${e.path}|${e.sha256}`).join('\n');
  const folders = skillFolders(plan).join(' ');
  return `#!/usr/bin/env bash
# Docket uninstall step for install ${plan.install_id} (Agent files).
# Removes only the files listed below, while they match their recorded hash.
# It never follows a link and never deletes a folder that still holds anything.
set -eu
export LC_ALL=C
base=$1
url=\${2:-}
INSTALL='${plan.install_id}'
DIR='${plan.dir}'
RECORDED='${plan.recordedBase ? 'yes' : 'no'}'
B='${DOCKET_BEGIN}'
E='${DOCKET_END}'
OB='${LEGACY_BEGIN}'
OE='${LEGACY_END}'
NL=$(printf '\\nx'); NL=\${NL%x}
CR=$(printf '\\r')
WS=$(printf ' \\t\\r\\nx'); WS=\${WS%x}
A='${CONNECTION_AWK}'
n_r=0; n_k=0; n_g=0; hold=0; j_r=''; j_k=''; j_g=''

h() { tr -d '\\r' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64; }
did() { n_r=$((n_r+1)); j_r="$j_r\${j_r:+,}\\"$1\\""; echo "  removed $2"; }
gone() { n_g=$((n_g+1)); j_g="$j_g\${j_g:+,}\\"$1\\""; echo "  already gone: $1"; }
kept() { n_k=$((n_k+1)); hold=$((hold+\${4:-1})); j_k="$j_k\${j_k:+,}{\\"path\\":\\"$1\\",\\"why\\":\\"$2\\"}"; echo "  kept $1 ($3)"; }
linked() {
  p=$base; r=$1
  while :; do
    c=\${r%%/*}; p=$p/$c
    if [ -L "$p" ]; then return 0; fi
    case $r in */*) r=\${r#*/} ;; *) return 1 ;; esac
  done
}
blank() { case $1 in *[!"$WS"]*) return 1 ;; *) return 0 ;; esac; }

remove_block() {
  rel=$1; sha=$2; f=$base/$rel
  old=$(cat "$f"; printf x); old=\${old%x}
  mb=$B; me=$E
  case $old in
    *"$B"*|*"$E"*)
      case $old in *"$OB"*|*"$OE"*) kept "$rel" damaged_markers "its Docket markers are damaged"; return ;; esac ;;
    *"$OB"*|*"$OE"*) mb=$OB; me=$OE ;;
    *) gone "$rel"; return ;;
  esac
  case $old in *"$mb"*) ;; *) kept "$rel" damaged_markers "its Docket markers are damaged"; return ;; esac
  pre=\${old%%"$mb"*}
  rest=\${old#*"$mb"}
  case $rest in *"$me"*) ;; *) kept "$rel" damaged_markers "its Docket markers are damaged"; return ;; esac
  inner=\${rest%%"$me"*}
  post=\${rest#*"$me"}
  case $pre in *"$me"*) kept "$rel" damaged_markers "its Docket markers are damaged"; return ;; esac
  case $inner in *"$mb"*) kept "$rel" damaged_markers "its Docket markers are damaged"; return ;; esac
  case $post in *"$mb"*|*"$me"*) kept "$rel" damaged_markers "its Docket markers are damaged"; return ;; esac
  x=$(printf '%s' "$inner" | tr -d '\\r'; printf x); x=\${x%x}; x=\${x#"$NL"}; x=\${x%"$NL"}
  if [ "$(printf '%s' "$x" | h)" != "$sha" ]; then
    kept "$rel" modified "its Docket section was edited"
    return
  fi
  case $post in "$CR$NL"*) post=\${post#"$CR$NL"} ;; "$NL"*) post=\${post#"$NL"} ;; esac
  if [ -z "$post" ]; then
    case $pre in *"$CR$NL$CR$NL") pre=\${pre%"$CR$NL"} ;; *"$NL$NL") pre=\${pre%"$NL"} ;; esac
  fi
  left=$pre$post
  if blank "$left"; then
    rm -f -- "$f"
    did "$rel" "$rel (nothing else was in it)"
  else
    printf '%s' "$left" > "$f"
    did "$rel" "the Docket section of $rel (nothing else changed)"
  fi
}

remove_connection() {
  rel=$1; sha=$2; f=$base/$rel
  x=$(awk -v mode=${mode} -v out=canon "$A" "$f")
  case $x in
    '!invalid') kept "$rel" modified "it can't be read, so it was left alone"; return ;;
    '!absent') gone "$rel"; return ;;
  esac
  if [ "$(printf '%s' "$x" | h)" != "$sha" ]; then
    kept "$rel" modified "its docket entry was changed"
    return
  fi
  cold=$(cat "$f"; printf x); cold=\${cold%x}
  set -- $(awk -v mode=${mode} -v out=pos "$A" "$f")
${
  mode === 'json'
    ? `  so=$6; sc=$7; ds=$9; de=\${10}
  head=\${cold:0:$ds}
  kh=\${head%\\"docket\\"*}
  tail=\${cold:$de}
  ws=\${tail%%[!"$WS"]*}
  after=\${tail#"$ws"}
  case $after in
    ,*)
      after=\${after#,}
      ws=\${after%%[!"$WS"]*}
      new=$kh\${after#"$ws"} ;;
    *)
      trimmed=\${kh%"\${kh##*[!"$WS"]}"}
      case $trimmed in
        *,) new=\${trimmed%,}$tail ;;
        *) new=\${cold:0:$so+1}\${cold:$sc} ;;
      esac ;;
  esac
  squeezed=$(printf '%s' "$new" | tr -d ' \\t\\r\\n')
  if [ "$squeezed" = '{"mcpServers":{}}' ]; then new=''; fi`
    : `  pre=\${cold:0:$2}; post=\${cold:$3}
  if [ -z "$post" ]; then
    case $pre in *"$CR$NL$CR$NL") pre=\${pre%"$CR$NL"} ;; *"$NL$NL") pre=\${pre%"$NL"} ;; esac
  fi
  new=$pre$post`
}
  if blank "$new"; then
    rm -f -- "$f"
    did "$rel" "$rel (only the docket server was in it)"
  else
    printf '%s' "$new" > "$f"
    did "$rel" "the docket server from $rel (nothing else changed)"
  fi
}

# 1. Is this the install's folder?
man=''
for m in "$DIR/${INSTALL_MANIFEST_NAME}" "$DIR/${LEGACY_MANIFEST_NAME}"; do
  if linked "$m"; then
    echo "Docket: $m is reached through a link, which uninstall never follows. Nothing was removed." >&2
    exit 1
  fi
  if [ -f "$base/$m" ]; then man=$m; break; fi
done
if [ -n "$man" ]; then
  found=$(grep -o 'ins_[0-9A-Za-z]*' "$base/$man" | head -n 1 || true)
  if [ "$found" != "$INSTALL" ]; then
    echo "Docket: $base has a different install ($found). Uninstall that one from Agent files instead. Nothing was removed." >&2
    exit 1
  fi
elif [ "$RECORDED" = no ]; then
  echo "Docket: no install $INSTALL here. Run this from the folder it was installed in. Nothing was removed." >&2
  exit 1
fi

echo "Uninstalling Docket install $INSTALL from $base"

# 2. Each file, only while it matches.
while IFS='|' read -r kind rel sha; do
  [ -n "$kind" ] || continue
  if linked "$rel"; then kept "$rel" link "it's a link, which uninstall never follows"; continue; fi
  f=$base/$rel
  if [ ! -e "$f" ]; then gone "$rel"; continue; fi
  if [ ! -f "$f" ]; then kept "$rel" not_a_file "it isn't a regular file"; continue; fi
  case $kind in
    block) remove_block "$rel" "$sha" ;;
    connection) remove_connection "$rel" "$sha" ;;
    script)
      if [ "$(h < "$f")" = "$sha" ]; then rm -f -- "$f"; did "$rel" "$rel"
      else kept "$rel" modified "it differs from the copy this Docket ships" 0; fi ;;
    *)
      if [ "$(h < "$f")" = "$sha" ]; then rm -f -- "$f"; did "$rel" "$rel"
      else kept "$rel" modified "it was edited after Docket wrote it"; fi ;;
  esac
done <<'DOCKET_ENTRIES'
${entries}
DOCKET_ENTRIES

# 3. Skill folders, only when empty.
for d in ${folders}; do
  [ -d "$base/$d" ] || continue
  if linked "$d"; then continue; fi
  if [ -e "$base/$d/SKILL.md" ]; then continue; fi
  if rmdir -- "$base/$d" 2>/dev/null; then echo "  removed $d/ (empty)"
  else kept "$d/" other_files "it holds other files"; fi
done

# 4. The manifest last, so an interrupted or partial run can be repeated.
if [ -n "$man" ]; then
  if [ "$hold" = 0 ]; then rm -f -- "$base/$man"; did "$man" "$man"
  else kept "$man" has_kept_files "it still describes the files kept above" 0; fi
fi

echo "Done: removed $n_r, kept $n_k, already gone $n_g."
if [ -n "$url" ]; then
  body="{\\"removed\\":[$j_r],\\"kept\\":[$j_k],\\"gone\\":[$j_g]}"
  if curl -fsS --noproxy '*' -X POST -H 'content-type: application/json' --data-binary "$body" "$url/report" > /dev/null 2>&1; then
    echo "Docket recorded the removal."
  else
    echo "Docket couldn't record this, so Agent files may still show it installed. Make a new uninstall command and run it: it's safe to repeat." >&2
    exit 2
  fi
fi
`;
}

export function uninstallPs1(plan: UninstallPlan): string {
  checkPlan(plan);
  const entries = plan.entries.map((e) => `  '${e.kind}|${e.path}|${e.sha256}'`).join(',\n');
  const folders = skillFolders(plan)
    .map((d) => `'${d}'`)
    .join(', ');
  const json = plan.client === 'claude';
  return `# Docket uninstall step for install ${plan.install_id} (Agent files).
# Removes only the files listed below, while they match their recorded hash.
# It never follows a link and never deletes a folder that still holds anything.
param([string]$Base, [string]$Url)
$ErrorActionPreference = 'Stop'
$Base = (Resolve-Path -LiteralPath $Base).ProviderPath
$enc = [Text.Encoding]::GetEncoding(28591)
$ord = [StringComparison]::Ordinal
$sha = [Security.Cryptography.SHA256]::Create()
$Install = '${plan.install_id}'
$Dir = '${plan.dir}'
$Recorded = ${plan.recordedBase ? '$true' : '$false'}
$B = '${DOCKET_BEGIN}'
$E = '${DOCKET_END}'
$OB = '${LEGACY_BEGIN}'
$OE = '${LEGACY_END}'
$NL = [string][char]10
$CR = [string][char]13
$WS = [char[]]@(32, 9, 13, 10)
$done = New-Object System.Collections.ArrayList
$left = New-Object System.Collections.ArrayList
$away = New-Object System.Collections.ArrayList
$hold = New-Object System.Collections.ArrayList
${CONNECTION_PS1}
function DkHash([string]$s) { -join ($sha.ComputeHash($enc.GetBytes($s.Replace($CR, ''))) | ForEach-Object { $_.ToString('x2') }) }
function DkFull([string]$rel) { $p = $Base; foreach ($c in $rel.Split('/')) { $p = Join-Path $p $c }; return $p }
function DkLinked([string]$rel) {
  $p = $Base
  foreach ($c in $rel.Split('/')) {
    $p = Join-Path $p $c
    $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($null -eq $i) { return $false }
    if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
  }
  return $false
}
function DkDid([string]$rel, [string]$what) { [void]$done.Add($rel); "  removed $what" }
function DkGone([string]$rel) { [void]$away.Add($rel); "  already gone: $rel" }
function DkKept([string]$rel, [string]$why, [string]$text, [bool]$holds = $true) {
  [void]$left.Add(@{ path = $rel; why = $why })
  if ($holds) { [void]$hold.Add($rel) }
  "  kept $rel ($text)"
}
function DkBlock([string]$rel, [string]$want) {
  $f = DkFull $rel
  $old = $enc.GetString([IO.File]::ReadAllBytes($f))
  $hasNew = $old.IndexOf($B, $ord) -ge 0 -or $old.IndexOf($E, $ord) -ge 0
  $hasOld = $old.IndexOf($OB, $ord) -ge 0 -or $old.IndexOf($OE, $ord) -ge 0
  if (-not $hasNew -and -not $hasOld) { DkGone $rel; return }
  $damaged = 'its Docket markers are damaged'
  if ($hasNew -and $hasOld) { DkKept $rel 'damaged_markers' $damaged; return }
  $mb = $B; $me = $E
  if ($hasOld) { $mb = $OB; $me = $OE }
  $at = $old.IndexOf($mb, $ord); $to = $old.IndexOf($me, $ord)
  if ($at -lt 0 -or $to -lt $at -or $old.IndexOf($mb, $at + 1, $ord) -ge 0 -or $old.IndexOf($me, $to + 1, $ord) -ge 0) { DkKept $rel 'damaged_markers' $damaged; return }
  $x = $old.Substring($at + $mb.Length, $to - $at - $mb.Length).Replace($CR, '')
  if ($x.StartsWith($NL, $ord)) { $x = $x.Substring(1) }
  if ($x.EndsWith($NL, $ord)) { $x = $x.Substring(0, $x.Length - 1) }
  if ((DkHash $x) -cne $want) { DkKept $rel 'modified' 'its Docket section was edited'; return }
  $pre = $old.Substring(0, $at); $post = $old.Substring($to + $me.Length)
  if ($post.StartsWith($CR + $NL, $ord)) { $post = $post.Substring(2) } elseif ($post.StartsWith($NL, $ord)) { $post = $post.Substring(1) }
  if ($post.Length -eq 0) {
    if ($pre.EndsWith($CR + $NL + $CR + $NL, $ord)) { $pre = $pre.Substring(0, $pre.Length - 2) } elseif ($pre.EndsWith($NL + $NL, $ord)) { $pre = $pre.Substring(0, $pre.Length - 1) }
  }
  $rest = $pre + $post
  if ($rest.Trim($WS).Length -eq 0) {
    [IO.File]::Delete($f)
    DkDid $rel "$rel (nothing else was in it)"
  } else {
    [IO.File]::WriteAllBytes($f, $enc.GetBytes($rest))
    DkDid $rel "the Docket section of $rel (nothing else changed)"
  }
}
function DkConnection([string]$rel, [string]$want) {
  $f = DkFull $rel
  $cold = $enc.GetString([IO.File]::ReadAllBytes($f))
  $x = DkCanon '${plan.client}' $cold
  if ($null -eq $x) { DkGone $rel; return }
  if ($x -ceq '!invalid') { DkKept $rel 'modified' "it can't be read, so it was left alone"; return }
  if ((DkHash $x) -cne $want) { DkKept $rel 'modified' 'its docket entry was changed'; return }
${
  json
    ? `  $r = DkJson $cold
  $head = $cold.Substring(0, $r.dkStart)
  $k = $head.LastIndexOf('"docket"', $ord)
  $kh = $head.Substring(0, $k)
  $tail = $cold.Substring($r.dkEnd)
  $after = $tail.TrimStart($WS)
  if ($after.StartsWith(',', $ord)) {
    $new = $kh + $after.Substring(1).TrimStart($WS)
  } else {
    $trimmed = $kh.TrimEnd($WS)
    if ($trimmed.EndsWith(',', $ord)) { $new = $trimmed.Substring(0, $trimmed.Length - 1) + $tail }
    else { $new = $cold.Substring(0, $r.srvOpen + 1) + $cold.Substring($r.srvClose) }
  }
  if (($new -replace '[ \\t\\r\\n]', '') -ceq '{"mcpServers":{}}') { $new = '' }`
    : `  $r = DkToml $cold
  $pre = $cold.Substring(0, $r.hdrStart); $post = ''
  if ($r.regionEnd -lt $cold.Length) { $post = $cold.Substring($r.regionEnd) }
  if ($post.Length -eq 0) {
    if ($pre.EndsWith($CR + $NL + $CR + $NL, $ord)) { $pre = $pre.Substring(0, $pre.Length - 2) } elseif ($pre.EndsWith($NL + $NL, $ord)) { $pre = $pre.Substring(0, $pre.Length - 1) }
  }
  $new = $pre + $post`
}
  if ($new.Trim($WS).Length -eq 0) {
    [IO.File]::Delete($f)
    DkDid $rel "$rel (only the docket server was in it)"
  } else {
    [IO.File]::WriteAllBytes($f, $enc.GetBytes($new))
    DkDid $rel "the docket server from $rel (nothing else changed)"
  }
}

# 1. Is this the install's folder?
$man = $null
foreach ($m in @(($Dir + '/${INSTALL_MANIFEST_NAME}'), ($Dir + '/${LEGACY_MANIFEST_NAME}'))) {
  if (DkLinked $m) { throw "Docket: $m is reached through a link, which uninstall never follows. Nothing was removed." }
  if (Test-Path -LiteralPath (DkFull $m) -PathType Leaf) { $man = $m; break }
}
if ($man) {
  $found = [regex]::Match([IO.File]::ReadAllText((DkFull $man)), 'ins_[0-9A-Za-z]*').Value
  if ($found -cne $Install) { throw "Docket: $Base has a different install ($found). Uninstall that one from Agent files instead. Nothing was removed." }
} elseif (-not $Recorded) {
  throw "Docket: no install $Install here. Run this from the folder it was installed in. Nothing was removed."
}

"Uninstalling Docket install $Install from $Base"

# 2. Each file, only while it matches.
$entries = @(
${entries}
)
foreach ($line in $entries) {
  $kind, $rel, $want = $line.Split('|')
  if (DkLinked $rel) { DkKept $rel 'link' "it's a link, which uninstall never follows"; continue }
  $f = DkFull $rel
  if (-not (Test-Path -LiteralPath $f)) { DkGone $rel; continue }
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { DkKept $rel 'not_a_file' "it isn't a regular file"; continue }
  if ($kind -ceq 'block') { DkBlock $rel $want; continue }
  if ($kind -ceq 'connection') { DkConnection $rel $want; continue }
  $same = (DkHash ($enc.GetString([IO.File]::ReadAllBytes($f)))) -ceq $want
  if ($same) { [IO.File]::Delete($f); DkDid $rel $rel }
  elseif ($kind -ceq 'script') { DkKept $rel 'modified' 'it differs from the copy this Docket ships' $false }
  else { DkKept $rel 'modified' 'it was edited after Docket wrote it' }
}

# 3. Skill folders, only when empty.
foreach ($d in @(${folders})) {
  $p = DkFull $d
  if (-not (Test-Path -LiteralPath $p -PathType Container)) { continue }
  if (DkLinked $d) { continue }
  if (Test-Path -LiteralPath (Join-Path $p 'SKILL.md')) { continue }
  if (@(Get-ChildItem -LiteralPath $p -Force).Count -eq 0) { [IO.Directory]::Delete($p, $false); "  removed $d/ (empty)" }
  else { DkKept ($d + '/') 'other_files' 'it holds other files' }
}

# 4. The manifest last, so an interrupted or partial run can be repeated.
if ($man) {
  if ($hold.Count -eq 0) { [IO.File]::Delete((DkFull $man)); DkDid $man $man }
  else { DkKept $man 'has_kept_files' 'it still describes the files kept above' $false }
}

"Done: removed $($done.Count), kept $($left.Count), already gone $($away.Count)."
if ($Url) {
  $jr = (@($done) | ForEach-Object { '"' + $_ + '"' }) -join ','
  $jk = (@($left) | ForEach-Object { '{"path":"' + $_.path + '","why":"' + $_.why + '"}' }) -join ','
  $jg = (@($away) | ForEach-Object { '"' + $_ + '"' }) -join ','
  $body = '{"removed":[' + $jr + '],"kept":[' + $jk + '],"gone":[' + $jg + ']}'
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -ContentType 'application/json' -Body $body -Uri ($Url + '/report') | Out-Null
    'Docket recorded the removal.'
  } catch {
    throw "Docket couldn't record this, so Agent files may still show it installed. Make a new uninstall command and run it: it's safe to repeat."
  }
}
`;
}
