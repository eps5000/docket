/**
 * The install step inside a command install's bundle (BUILD_SPEC §5.17):
 * `install.sh` (bash) and `install.ps1` (PowerShell 5.1 and 7). The
 * copy-paste command unpacks the bundle into a temporary folder and runs one
 * of them with the bundle folder and the base (the repo folder, or home).
 *
 * Each one:
 * 1. checks the instructions file's markers first, and stops without writing
 *    anything if one is missing or repeated;
 * 2. copies the files listed in `files.txt` (the skills and the manifest)
 *    into the base, creating folders as needed, and deletes nothing;
 * 3. merges `block.md` into the instructions file between
 *    `<!-- tasklite:begin -->` and `<!-- tasklite:end -->`: replaced in
 *    place, or appended after a blank line, or a new file. Everything outside
 *    the markers keeps its exact bytes: bash works on bytes (`LC_ALL=C`
 *    parameter expansion), PowerShell decodes and encodes as latin1, which
 *    round-trips every byte.
 *
 * They are the same rules as `mergeMarkedSection` in @docket/shared, and
 * they need nothing beyond the shell itself (no Node, no Python). ASCII
 * only, so PowerShell 5.1 reads them the same in any code page.
 */
import { DOCKET_BEGIN, DOCKET_END } from '@docket/shared';

/** `CLAUDE.md`, `.codex/AGENTS.md`: only these fixed values are put in the scripts. */
const SAFE_RELATIVE = /^[A-Za-z0-9._/-]+$/;

export function installSh(instructions: string): string {
  if (!SAFE_RELATIVE.test(instructions)) throw new Error(`unsafe path: ${instructions}`);
  return `#!/usr/bin/env bash
# Task Lite install step (Agent files). Copies the agent files into
# place and merges the Task Lite section of ${instructions} between its markers.
# Nothing outside the markers changes, and nothing is deleted.
set -eu
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
base=$1
instr="$base/${instructions}"
B='${DOCKET_BEGIN}'
E='${DOCKET_END}'
broken() {
  echo "Task Lite: $instr has a damaged Task Lite section (a $B or $E line is missing or repeated). Fix the markers, then make a new install command. Nothing was written." >&2
  exit 1
}

# 1. Check the markers before writing anything.
had=no
if [ -f "$instr" ]; then
  old=$(cat "$instr"; printf x); old=\${old%x}
  case $old in
    *"$B"*)
      rest=\${old#*"$B"}
      case $rest in *"$E"*) ;; *) broken ;; esac
      mid=\${rest%%"$E"*}
      post=\${rest#*"$E"}
      case $mid in *"$B"*) broken ;; esac
      case $post in *"$B"*|*"$E"*) broken ;; esac
      had=yes
      ;;
    *"$E"*) broken ;;
  esac
fi

# 2. The skills and the manifest.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$base/$(dirname "$f")"
  cp "$here/files/$f" "$base/$f"
  echo "  wrote $f"
done < "$here/files.txt"

# 3. The marked section.
blk=$(cat "$here/block.md"; printf x); blk=\${blk%x}
sec="$B
$blk
$E"
if [ ! -f "$instr" ]; then
  mkdir -p "$(dirname "$instr")"
  printf '%s\\n' "$sec" > "$instr"
  echo "  created ${instructions} with the Task Lite section"
elif [ "$had" = yes ]; then
  printf '%s' "\${old%%"$B"*}$sec$post" > "$instr"
  echo "  replaced the Task Lite section of ${instructions} (nothing else changed)"
elif [ -z "$old" ]; then
  printf '%s\\n' "$sec" > "$instr"
  echo "  added the Task Lite section to ${instructions}"
else
  case $old in
    *'
') printf '%s\\n%s\\n' "$old" "$sec" > "$instr" ;;
    *) printf '%s\\n\\n%s\\n' "$old" "$sec" > "$instr" ;;
  esac
  echo "  added the Task Lite section to the end of ${instructions} (nothing else changed)"
fi
echo "Done: Task Lite agent files installed in $base"
`;
}

export function installPs1(instructions: string): string {
  if (!SAFE_RELATIVE.test(instructions)) throw new Error(`unsafe path: ${instructions}`);
  return `# Task Lite install step (Agent files). Copies the agent files into
# place and merges the Task Lite section of ${instructions} between its markers.
# Nothing outside the markers changes, and nothing is deleted.
param([string]$Here, [string]$Base)
$ErrorActionPreference = 'Stop'
$Base = (Resolve-Path -LiteralPath $Base).ProviderPath
$enc = [Text.Encoding]::GetEncoding(28591)
$Begin = '${DOCKET_BEGIN}'
$End = '${DOCKET_END}'
$instr = Join-Path $Base '${instructions}'
$ord = [StringComparison]::Ordinal

# 1. Check the markers before writing anything.
$old = $null; $at = -1; $to = -1
if (Test-Path -LiteralPath $instr -PathType Leaf) {
  $old = $enc.GetString([IO.File]::ReadAllBytes($instr))
  $at = $old.IndexOf($Begin, $ord)
  $to = $old.IndexOf($End, $ord)
  $bad = $false
  if ($at -lt 0 -and $to -ge 0) { $bad = $true }
  if ($at -ge 0) {
    if ($to -lt $at) { $bad = $true }
    elseif ($old.IndexOf($Begin, $at + 1, $ord) -ge 0 -or $old.IndexOf($End, $to + 1, $ord) -ge 0) { $bad = $true }
  }
  if ($bad) {
    throw "Task Lite: $instr has a damaged Task Lite section (a $Begin or $End line is missing or repeated). Fix the markers, then make a new install command. Nothing was written."
  }
}

# 2. The skills and the manifest.
foreach ($f in [IO.File]::ReadAllLines((Join-Path $Here 'files.txt'))) {
  if (-not $f) { continue }
  $src = Join-Path (Join-Path $Here 'files') $f
  $dst = Join-Path $Base $f
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllBytes($dst, [IO.File]::ReadAllBytes($src))
  "  wrote $f"
}

# 3. The marked section.
$blk = $enc.GetString([IO.File]::ReadAllBytes((Join-Path $Here 'block.md')))
$sec = $Begin + "\`n" + $blk + "\`n" + $End
if ($null -eq $old) {
  $dir = Split-Path -Parent $instr
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $new = $sec + "\`n"; $msg = 'created ${instructions} with the Task Lite section'
} elseif ($at -ge 0) {
  $new = $old.Substring(0, $at) + $sec + $old.Substring($to + $End.Length)
  $msg = 'replaced the Task Lite section of ${instructions} (nothing else changed)'
} elseif ($old.Length -eq 0) {
  $new = $sec + "\`n"; $msg = 'added the Task Lite section to ${instructions}'
} elseif ($old.EndsWith("\`n", $ord)) {
  $new = $old + "\`n" + $sec + "\`n"; $msg = 'added the Task Lite section to the end of ${instructions} (nothing else changed)'
} else {
  $new = $old + "\`n\`n" + $sec + "\`n"; $msg = 'added the Task Lite section to the end of ${instructions} (nothing else changed)'
}
[IO.File]::WriteAllBytes($instr, $enc.GetBytes($new))
"  $msg"
"Done: Task Lite agent files installed in $Base"
`;
}
