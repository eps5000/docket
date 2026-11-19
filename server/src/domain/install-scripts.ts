/**
 * The install step inside a command install's bundle (BUILD_SPEC §5.17):
 * `install.sh` (bash) and `install.ps1` (PowerShell 5.1 and 7). The
 * copy-paste command unpacks the bundle into a temporary folder and runs one
 * of them with the bundle folder and the base (the repo folder, or home).
 *
 * Each one:
 * 1. checks the instructions file's markers first, and stops without writing
 *    anything if one is missing or repeated. The old `<!-- tasklite:begin -->`
 *    and `<!-- tasklite:end -->` pair (B28) is a valid section; both kinds in
 *    one file are refused;
 * 2. reads the previous manifest there (`.docket-manifest.json`, or the old
 *    `.tasklite-manifest.json`) for old `tasklite-*` skill folders it
 *    recorded. A folder that still holds only its `SKILL.md`, matching the
 *    recorded hash, is removed after the copy: the one deletion allowed, of a
 *    folder Docket itself installed and recorded. An edited one is kept and
 *    reported ("old name, edited locally");
 * 3. copies the files listed in `files.txt` (the skills and the manifest)
 *    into the base, creating folders as needed;
 * 4. merges `block.md` into the instructions file between
 *    `<!-- docket:begin -->` and `<!-- docket:end -->`: replaced in place
 *    (an old `tasklite` section too, with the new markers), or appended after
 *    a blank line, or a new file. Everything outside the markers keeps its
 *    exact bytes: bash works on bytes (`LC_ALL=C` parameter expansion),
 *    PowerShell decodes and encodes as latin1, which round-trips every byte.
 *
 * 5. for a repo install, merges `connection.txt` into the client's project
 *    connection file (decision 32; BUILD_SPEC §5.17a): `.mcp.json` or
 *    `.codex/config.toml`, adding or replacing only the `docket` entry. The
 *    file is scanned in step 1, and an invalid one stops the install before
 *    anything is written. The scanners are `CONNECTION_AWK` (bash, POSIX awk)
 *    and `CONNECTION_PS1`, the same rules as `mergeConnection`.
 *
 * They are the same rules as `mergeMarkedSection` in @docket/shared, and
 * they need nothing beyond the shell itself (no Node, no Python). ASCII
 * only, so PowerShell 5.1 reads them the same in any code page.
 */
import {
  CONNECTION_AWK,
  CONNECTION_FILES,
  CONNECTION_PS1,
  DOCKET_BEGIN,
  DOCKET_END,
  INSTALL_CLIENT_LABELS,
  INSTALL_MANIFEST_NAME,
  type InstallClient,
  LEGACY_BEGIN,
  LEGACY_CHECK_SCRIPTS,
  LEGACY_END,
  LEGACY_MANIFEST_NAME,
  LEGACY_SKILL_PREFIX,
} from '@docket/shared';

/** `CLAUDE.md`, `.codex/AGENTS.md`: only these fixed values are put in the scripts. */
const SAFE_RELATIVE = /^[A-Za-z0-9._/-]+$/;

function checkSafe(...paths: string[]): void {
  for (const p of paths) if (!SAFE_RELATIVE.test(p)) throw new Error(`unsafe path: ${p}`);
}

/**
 * @param instructions the instructions file, relative to the base.
 * @param dir the client's folder, relative to the base (`.claude`, `.codex`).
 */
export function installSh(instructions: string, dir: string, client: InstallClient): string {
  checkSafe(instructions, dir);
  const leftovers = [LEGACY_MANIFEST_NAME, ...LEGACY_CHECK_SCRIPTS].join(' ');
  const conn = CONNECTION_FILES[client];
  const json = client === 'claude';
  const label = INSTALL_CLIENT_LABELS[client];
  return `#!/usr/bin/env bash
# Docket install step (Agent files). Copies the agent files into
# place and merges the Docket section of ${instructions} between its markers.
# Nothing outside the markers changes. The only thing it deletes is an old
# ${LEGACY_SKILL_PREFIX}* skill folder that an earlier install recorded, and only
# while it is unmodified.
set -eu
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
base=$1
instr="$base/${instructions}"
B='${DOCKET_BEGIN}'
E='${DOCKET_END}'
OB='${LEGACY_BEGIN}'
OE='${LEGACY_END}'
broken() {
  echo "Docket: $instr has a damaged Docket section (a $B or $E line is missing or repeated, or it has both the old and the new markers). Fix the markers, then make a new install command. Nothing was written." >&2
  exit 1
}
h() { tr -d '\\r' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64; }

# 1. Check the markers before writing anything. The old pair is a valid section.
had=no
mb=$B
me=$E
legacy=no
if [ -f "$instr" ]; then
  old=$(cat "$instr"; printf x); old=\${old%x}
  case $old in
    *"$B"*|*"$E"*)
      case $old in *"$OB"*|*"$OE"*) broken ;; esac
      ;;
    *"$OB"*|*"$OE"*)
      mb=$OB
      me=$OE
      legacy=yes
      ;;
  esac
  case $old in
    *"$mb"*)
      rest=\${old#*"$mb"}
      case $rest in *"$me"*) ;; *) broken ;; esac
      mid=\${rest%%"$me"*}
      post=\${rest#*"$me"}
      case $mid in *"$mb"*) broken ;; esac
      case $post in *"$mb"*|*"$me"*) broken ;; esac
      had=yes
      ;;
    *"$me"*) broken ;;
  esac
fi

# 1b. The connection file (repo installs): scanned before anything is written.
cf="$base/${conn}"
ctx="$here/connection.txt"
NL=$(printf '\\nx'); NL=\${NL%x}
A='${CONNECTION_AWK}'
cpos=''
if [ -f "$ctx" ] && [ -f "$cf" ]; then
  cpos=$(awk -v mode=${json ? 'json' : 'toml'} -v out=pos "$A" "$cf")
  case $cpos in
    ok*) ;;
    'err docket defined another way')
      echo "Docket: ${conn} defines the docket MCP server in a form Docket can't update; make it a [mcp_servers.docket] table, then make a new install command. Nothing was written." >&2
      exit 1 ;;
    *)
      echo "Docket: ${conn} isn't valid ${json ? 'JSON' : 'TOML'} (\${cpos#err }). Fix it, then make a new install command. Nothing was written." >&2
      exit 1 ;;
  esac
fi

# 2. Old skill folders an earlier install recorded: removed after the copy while
# unmodified (only SKILL.md, matching the recorded hash); an edited one is kept.
remove=''
kept=''
for om in "$base/${dir}/${INSTALL_MANIFEST_NAME}" "$base/${dir}/${LEGACY_MANIFEST_NAME}"; do
  [ -f "$om" ] || continue
  while IFS= read -r l; do
    case $l in *'"key":"skill:${LEGACY_SKILL_PREFIX}'*) ;; *) continue ;; esac
    k=\${l#*'"key":"skill:'}; k=\${k%%'"'*}
    p=\${l#*'"path":"'}; p=\${p%%'"'*}
    s=\${l#*'"sha256":"'}; s=\${s%%'"'*}
    case $k in ''|*[!a-z0-9-]*) continue ;; esac
    [ "$p" = "${dir}/skills/$k/SKILL.md" ] || continue
    d="$base/${dir}/skills/$k"
    [ -d "$d" ] || continue
    case " $remove $kept " in *" $k "*) continue ;; esac
    if [ "$(ls -A "$d")" = SKILL.md ] && [ -f "$d/SKILL.md" ] && [ "$(h < "$d/SKILL.md")" = "$s" ]; then
      remove="$remove $k"
    else
      kept="$kept $k"
    fi
  done < "$om"
done

# 3. The skills and the manifest.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$base/$(dirname "$f")"
  cp "$here/files/$f" "$base/$f"
  echo "  wrote $f"
done < "$here/files.txt"
for k in $remove; do
  rm -f "$base/${dir}/skills/$k/SKILL.md"
  rmdir "$base/${dir}/skills/$k"
  echo "  removed ${dir}/skills/$k/ (the old name, unmodified)"
done
for k in $kept; do
  echo "  kept ${dir}/skills/$k/ (old name, edited locally): Agent files offers Adopt or Keep local once an agent reports it"
done
left=''
for f in ${leftovers}; do
  if [ -f "$base/${dir}/$f" ]; then left="$left ${dir}/$f"; fi
done
if [ -n "$left" ]; then
  echo "  left$left from before the rename; nothing reads them now, so delete them when you like"
fi

# 4. The marked section.
blk=$(cat "$here/block.md"; printf x); blk=\${blk%x}
sec="$B
$blk
$E"
if [ ! -f "$instr" ]; then
  mkdir -p "$(dirname "$instr")"
  printf '%s\\n' "$sec" > "$instr"
  echo "  created ${instructions} with the Docket section"
elif [ "$had" = yes ]; then
  printf '%s' "\${old%%"$mb"*}$sec$post" > "$instr"
  if [ "$legacy" = yes ]; then
    echo "  replaced the old tasklite section of ${instructions} with the Docket section (nothing else changed)"
  else
    echo "  replaced the Docket section of ${instructions} (nothing else changed)"
  fi
elif [ -z "$old" ]; then
  printf '%s\\n' "$sec" > "$instr"
  echo "  added the Docket section to ${instructions}"
else
  case $old in
    *'
') printf '%s\\n%s\\n' "$old" "$sec" > "$instr" ;;
    *) printf '%s\\n\\n%s\\n' "$old" "$sec" > "$instr" ;;
  esac
  echo "  added the Docket section to the end of ${instructions} (nothing else changed)"
fi

# 5. The connection file: only its docket entry is added or replaced.
if [ -f "$ctx" ]; then
  ent=$(cat "$ctx"; printf x); ent=\${ent%x}
  mkdir -p "$(dirname "$cf")"
${
  json
    ? `  fresh="{$NL  \\"mcpServers\\": {$NL    \\"docket\\": $ent$NL  }$NL}$NL"
  if [ ! -f "$cf" ]; then
    new=$fresh; how=created
  else
    cold=$(cat "$cf"; printf x); cold=\${cold%x}
    set -- $cpos
    how=added
    if [ "$2" = 0 ]; then
      new=$fresh
    elif [ "$9" -ge 0 ]; then
      new="\${cold:0:$9}$ent\${cold:\${10}}"; how=replaced
    elif [ "$6" -ge 0 ] && [ "$8" = 1 ]; then
      new="\${cold:0:$6+1}$NL    \\"docket\\": $ent$NL  \${cold:$7}"
    elif [ "$6" -ge 0 ]; then
      new="\${cold:0:$6+1}$NL    \\"docket\\": $ent,\${cold:$6+1}"
    elif [ "$5" = 1 ]; then
      new="\${cold:0:$3+1}$NL  \\"mcpServers\\": {$NL    \\"docket\\": $ent$NL  }$NL\${cold:$4}"
    else
      new="\${cold:0:$3+1}$NL  \\"mcpServers\\": {$NL    \\"docket\\": $ent$NL  },\${cold:$3+1}"
    fi
  fi`
    : `  if [ ! -f "$cf" ]; then
    new=$ent; how=created
  else
    cold=$(cat "$cf"; printf x); cold=\${cold%x}
    set -- $cpos
    how=added
    if [ "$2" -ge 0 ]; then
      new="\${cold:0:$2}$ent\${cold:$3}"; how=replaced
    elif [ -z "$cold" ]; then
      new=$ent
    else
      case $cold in
        *"$NL") new="$cold$NL$ent" ;;
        *) new="$cold$NL$NL$ent" ;;
      esac
    fi
  fi`
}
  printf '%s' "$new" > "$cf"
  case $how in
    created) echo "  created ${conn}: ${label} connects to Docket from this repo" ;;
    replaced) echo "  updated the docket server in ${conn} (nothing else changed)" ;;
    *) echo "  added the docket server to ${conn} (nothing else changed)" ;;
  esac
  echo "Then open ${label} in this repo and approve Docket when it asks."
fi
echo "Done: Docket agent files installed in $base"
`;
}

/**
 * @param instructions the instructions file, relative to the base.
 * @param dir the client's folder, relative to the base (`.claude`, `.codex`).
 */
export function installPs1(instructions: string, dir: string, client: InstallClient): string {
  checkSafe(instructions, dir);
  const leftovers = [LEGACY_MANIFEST_NAME, ...LEGACY_CHECK_SCRIPTS].map((n) => `'${n}'`).join(', ');
  const conn = CONNECTION_FILES[client];
  const json = client === 'claude';
  const label = INSTALL_CLIENT_LABELS[client];
  return `# Docket install step (Agent files). Copies the agent files into
# place and merges the Docket section of ${instructions} between its markers.
# Nothing outside the markers changes. The only thing it deletes is an old
# ${LEGACY_SKILL_PREFIX}* skill folder that an earlier install recorded, and only
# while it is unmodified.
param([string]$Here, [string]$Base)
$ErrorActionPreference = 'Stop'
$Base = (Resolve-Path -LiteralPath $Base).ProviderPath
$enc = [Text.Encoding]::GetEncoding(28591)
$Begin = '${DOCKET_BEGIN}'
$End = '${DOCKET_END}'
$OldBegin = '${LEGACY_BEGIN}'
$OldEnd = '${LEGACY_END}'
$instr = Join-Path $Base '${instructions}'
$cdir = Join-Path $Base '${dir}'
$ord = [StringComparison]::Ordinal
$sha = [Security.Cryptography.SHA256]::Create()

# 1. Check the markers before writing anything. The old pair is a valid section.
$old = $null; $at = -1; $to = -1; $mb = $Begin; $me = $End; $legacy = $false
if (Test-Path -LiteralPath $instr -PathType Leaf) {
  $old = $enc.GetString([IO.File]::ReadAllBytes($instr))
  $bad = $false
  $hasNew = $old.IndexOf($Begin, $ord) -ge 0 -or $old.IndexOf($End, $ord) -ge 0
  $hasOld = $old.IndexOf($OldBegin, $ord) -ge 0 -or $old.IndexOf($OldEnd, $ord) -ge 0
  if ($hasNew -and $hasOld) { $bad = $true }
  elseif ($hasOld) { $mb = $OldBegin; $me = $OldEnd; $legacy = $true }
  $at = $old.IndexOf($mb, $ord)
  $to = $old.IndexOf($me, $ord)
  if ($at -lt 0 -and $to -ge 0) { $bad = $true }
  if ($at -ge 0) {
    if ($to -lt $at) { $bad = $true }
    elseif ($old.IndexOf($mb, $at + 1, $ord) -ge 0 -or $old.IndexOf($me, $to + 1, $ord) -ge 0) { $bad = $true }
  }
  if ($bad) {
    throw "Docket: $instr has a damaged Docket section (a $Begin or $End line is missing or repeated, or it has both the old and the new markers). Fix the markers, then make a new install command. Nothing was written."
  }
}

# 1b. The connection file (repo installs): scanned before anything is written.
${CONNECTION_PS1}
$cf = Join-Path $Base '${conn}'
$ctx = Join-Path $Here 'connection.txt'
$cold = $null; $cr = $null
if ((Test-Path -LiteralPath $ctx -PathType Leaf) -and (Test-Path -LiteralPath $cf -PathType Leaf)) {
  $cold = $enc.GetString([IO.File]::ReadAllBytes($cf))
  $cr = ${json ? 'DkJson' : 'DkToml'} $cold
  if (-not $cr.ok) {
    if ($cr.error -ceq 'docket defined another way') {
      throw "Docket: ${conn} defines the docket MCP server in a form Docket can't update; make it a [mcp_servers.docket] table, then make a new install command. Nothing was written."
    }
    throw "Docket: ${conn} isn't valid ${json ? 'JSON' : 'TOML'} ($($cr.error)). Fix it, then make a new install command. Nothing was written."
  }
}

# 2. Old skill folders an earlier install recorded: removed after the copy while
# unmodified (only SKILL.md, matching the recorded hash); an edited one is kept.
$remove = @(); $kept = @()
foreach ($n in @('${INSTALL_MANIFEST_NAME}', '${LEGACY_MANIFEST_NAME}')) {
  $om = Join-Path $cdir $n
  if (-not (Test-Path -LiteralPath $om -PathType Leaf)) { continue }
  $oj = [IO.File]::ReadAllText($om) | ConvertFrom-Json
  foreach ($r in @($oj.files)) {
    if ([string]$r.key -cnotmatch '^skill:(${LEGACY_SKILL_PREFIX}[a-z0-9-]+)$') { continue }
    $k = $Matches[1]
    if ([string]$r.path -cne ('${dir}/skills/' + $k + '/SKILL.md')) { continue }
    if ($remove -contains $k -or $kept -contains $k) { continue }
    $d = Join-Path (Join-Path $cdir 'skills') $k
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }
    $items = @(Get-ChildItem -LiteralPath $d -Force)
    $f = Join-Path $d 'SKILL.md'
    $same = $false
    if ($items.Count -eq 1 -and $items[0].Name -ceq 'SKILL.md' -and (Test-Path -LiteralPath $f -PathType Leaf)) {
      $x = $enc.GetString([IO.File]::ReadAllBytes($f)).Replace("\`r", '')
      $hx = -join ($sha.ComputeHash($enc.GetBytes($x)) | ForEach-Object { $_.ToString('x2') })
      $same = $hx -eq ([string]$r.sha256).ToLower()
    }
    if ($same) { $remove += $k } else { $kept += $k }
  }
}

# 3. The skills and the manifest.
foreach ($f in [IO.File]::ReadAllLines((Join-Path $Here 'files.txt'))) {
  if (-not $f) { continue }
  $src = Join-Path (Join-Path $Here 'files') $f
  $dst = Join-Path $Base $f
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllBytes($dst, [IO.File]::ReadAllBytes($src))
  "  wrote $f"
}
foreach ($k in $remove) {
  $d = Join-Path (Join-Path $cdir 'skills') $k
  Remove-Item -LiteralPath (Join-Path $d 'SKILL.md') -Force
  Remove-Item -LiteralPath $d
  "  removed ${dir}/skills/$k/ (the old name, unmodified)"
}
foreach ($k in $kept) {
  "  kept ${dir}/skills/$k/ (old name, edited locally): Agent files offers Adopt or Keep local once an agent reports it"
}
$left = @()
foreach ($n in @(${leftovers})) {
  if (Test-Path -LiteralPath (Join-Path $cdir $n) -PathType Leaf) { $left += '${dir}/' + $n }
}
if ($left.Count -gt 0) {
  "  left $($left -join ' ') from before the rename; nothing reads them now, so delete them when you like"
}

# 4. The marked section.
$blk = $enc.GetString([IO.File]::ReadAllBytes((Join-Path $Here 'block.md')))
$sec = $Begin + "\`n" + $blk + "\`n" + $End
if ($null -eq $old) {
  $dir = Split-Path -Parent $instr
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $new = $sec + "\`n"; $msg = 'created ${instructions} with the Docket section'
} elseif ($at -ge 0) {
  $new = $old.Substring(0, $at) + $sec + $old.Substring($to + $me.Length)
  if ($legacy) { $msg = 'replaced the old tasklite section of ${instructions} with the Docket section (nothing else changed)' }
  else { $msg = 'replaced the Docket section of ${instructions} (nothing else changed)' }
} elseif ($old.Length -eq 0) {
  $new = $sec + "\`n"; $msg = 'added the Docket section to ${instructions}'
} elseif ($old.EndsWith("\`n", $ord)) {
  $new = $old + "\`n" + $sec + "\`n"; $msg = 'added the Docket section to the end of ${instructions} (nothing else changed)'
} else {
  $new = $old + "\`n\`n" + $sec + "\`n"; $msg = 'added the Docket section to the end of ${instructions} (nothing else changed)'
}
[IO.File]::WriteAllBytes($instr, $enc.GetBytes($new))
"  $msg"

# 5. The connection file: only its docket entry is added or replaced.
if (Test-Path -LiteralPath $ctx -PathType Leaf) {
  $ent = $enc.GetString([IO.File]::ReadAllBytes($ctx))
  $NL = [string][char]10
  $how = 'added'
${
  json
    ? `  $fresh = '{' + $NL + '  "mcpServers": {' + $NL + '    "docket": ' + $ent + $NL + '  }' + $NL + '}' + $NL
  if ($null -eq $cold) { $new = $fresh; $how = 'created' }
  elseif (-not $cr.nonEmpty) { $new = $fresh }
  elseif ($cr.dkStart -ge 0) { $new = $cold.Substring(0, $cr.dkStart) + $ent + $cold.Substring($cr.dkEnd); $how = 'replaced' }
  elseif ($cr.srvOpen -ge 0 -and $cr.srvEmpty) { $new = $cold.Substring(0, $cr.srvOpen + 1) + $NL + '    "docket": ' + $ent + $NL + '  ' + $cold.Substring($cr.srvClose) }
  elseif ($cr.srvOpen -ge 0) { $new = $cold.Substring(0, $cr.srvOpen + 1) + $NL + '    "docket": ' + $ent + ',' + $cold.Substring($cr.srvOpen + 1) }
  elseif ($cr.topEmpty) { $new = $cold.Substring(0, $cr.topOpen + 1) + $NL + '  "mcpServers": {' + $NL + '    "docket": ' + $ent + $NL + '  }' + $NL + $cold.Substring($cr.topClose) }
  else { $new = $cold.Substring(0, $cr.topOpen + 1) + $NL + '  "mcpServers": {' + $NL + '    "docket": ' + $ent + $NL + '  },' + $cold.Substring($cr.topOpen + 1) }`
    : `  if ($null -eq $cold) { $new = $ent; $how = 'created' }
  elseif ($cr.hdrStart -ge 0) { $tail = ''; if ($cr.regionEnd -lt $cold.Length) { $tail = $cold.Substring($cr.regionEnd) }; $new = $cold.Substring(0, $cr.hdrStart) + $ent + $tail; $how = 'replaced' }
  elseif ($cold.Length -eq 0) { $new = $ent }
  elseif ($cold.EndsWith($NL, $ord)) { $new = $cold + $NL + $ent }
  else { $new = $cold + $NL + $NL + $ent }`
}
  $cdir2 = Split-Path -Parent $cf
  if (-not (Test-Path -LiteralPath $cdir2)) { New-Item -ItemType Directory -Force -Path $cdir2 | Out-Null }
  [IO.File]::WriteAllBytes($cf, $enc.GetBytes($new))
  if ($how -ceq 'created') { "  created ${conn}: ${label} connects to Docket from this repo" }
  elseif ($how -ceq 'replaced') { "  updated the docket server in ${conn} (nothing else changed)" }
  else { "  added the docket server to ${conn} (nothing else changed)" }
  "Then open ${label} in this repo and approve Docket when it asks."
}
"Done: Docket agent files installed in $Base"
`;
}
