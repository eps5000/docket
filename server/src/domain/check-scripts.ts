/**
 * The installed `tasklite-check` script (owner decision 30; BUILD_SPEC
 * §5.19; T161): `tasklite-check.sh` (bash) and `tasklite-check.ps1`
 * (PowerShell 5.1 and 7), installed next to the manifest (`.claude/` or
 * `.codex/`, in the repo or the home folder) by both install methods.
 *
 * It hashes each installed file exactly as B24's check does
 * (`checkCommands` in @docket/shared, `inspectPushInstall` on the server):
 * CR bytes removed, and the AGENTS.md block as the text between the Docket markers less one newline at each end. It compares each hash with the
 * manifest and prints one line of JSON, the `instructions` argument of
 * `claim_lead`:
 *
 *     {"install_id":"ins_…","files":[{"key":"skill:tasklite-worker","sha256":"…"}, …]}
 *
 * - a file that matches is listed with its hash only, so a typical report is
 *   a few hundred characters;
 * - a file that differs also carries its text (`content`, up to 50,000
 *   characters; longer text is left out), for the owner's diff and *Adopt*;
 * - a missing file is left out: Docket reads its absence as missing;
 * - an extra `tasklite-*` skill folder is listed as `skill:<name>` with its
 *   `SKILL.md` text;
 * - at most 20 files, and only valid keys, so the report always passes
 *   `claim_lead`'s schema.
 *
 * It reads only: it writes, deletes and downloads nothing. ASCII only, so
 * PowerShell 5.1 reads it the same in any code page, and the PowerShell
 * version prints non-ASCII text as `\uXXXX` for the same reason.
 */
import { DOCKET_BEGIN, DOCKET_END } from '@docket/shared';

/** The installed script's file names, next to the manifest. */
export const CHECK_SCRIPT_SH = 'tasklite-check.sh';
export const CHECK_SCRIPT_PS1 = 'tasklite-check.ps1';

export function checkSh(): string {
  return `#!/usr/bin/env bash
# Docket tasklite-check (Agent files). Hashes the installed agent files, compares
# them with .tasklite-manifest.json, and prints the report to pass as instructions
# on claim_lead: one line of JSON, with the text only of files that differ.
# It reads only: it writes and downloads nothing.
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
base=$(dirname "$here")
m="$here/.tasklite-manifest.json"
B='${DOCKET_BEGIN}'
E='${DOCKET_END}'
TAB=$(printf '\\t')
[ -f "$m" ] || { echo "No Docket install found: $m is missing." >&2; exit 1; }
h() { tr -d '\\r' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64; }
# A JSON string's body from stdin: CRs and other control characters (but tab and
# newline) dropped, backslash, quote and tab escaped, newlines as \\n. The x keeps
# a final newline through sed and awk.
js() { r=$({ tr -d '\\r\\001-\\010\\013\\014\\016-\\037\\177'; printf x; } | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e "s/$TAB/\\\\\\\\t/g" | awk 'BEGIN{ORS=""} NR>1{print "\\\\n"} {print}'); printf '%s' "\${r%x}"; }
id=$(grep -o 'ins_[0-9A-Za-z]*' "$m" | head -n 1)
out=''; n=0; known=' '
add() { # key sha [file whose text to include]
  e="{\\"key\\":\\"$1\\",\\"sha256\\":\\"$2\\""
  if [ -n "\${3-}" ]; then
    sz=$(wc -c < "$3"); sz=$((sz + 0))
    if [ "$sz" -le 50000 ]; then e="$e,\\"content\\":\\"$(js < "$3")\\""; fi
  fi
  out="$out\${out:+,}$e}"; n=$((n + 1))
}
t=$(mktemp); trap 'rm -f "$t"' EXIT
while IFS= read -r l; do
  case $l in *'"key":"'*) ;; *) continue ;; esac
  k=\${l#*'"key":"'}; k=\${k%%'"'*}; p=\${l#*'"path":"'}; p=\${p%%'"'*}; s=\${l#*'"sha256":"'}; s=\${s%%'"'*}
  known="$known$k "
  f="$base/$p"
  [ -f "$f" ] || continue
  if [ "$k" = agents_block ]; then
    x=$(cat "$f"; printf x); x=\${x%x}
    case $x in *"$B"*"$E"*) ;; *) continue ;; esac
    x=\${x#*"$B"}; x=\${x%%"$E"*}; x=$(printf '%s' "$x" | tr -d '\\r'; printf x); x=\${x%x}; x=\${x#$'\\n'}; x=\${x%$'\\n'}
    printf '%s' "$x" > "$t"
  else
    tr -d '\\r' < "$f" > "$t"
  fi
  got=$(h < "$t")
  if [ "$got" = "$s" ]; then add "$k" "$got"; else add "$k" "$got" "$t"; fi
done < "$m"
for x in "$here"/skills/tasklite-*/; do
  [ -d "$x" ] || continue
  y=\${x%/}; y=\${y##*/}
  case $y in *[!a-z0-9-]*) continue ;; esac
  [ \${#y} -le 60 ] || continue
  case $known in *" skill:$y "*) continue ;; esac
  [ "$n" -lt 20 ] || break
  if [ -f "\${x}SKILL.md" ]; then
    tr -d '\\r' < "\${x}SKILL.md" > "$t"; add "skill:$y" "$(h < "$t")" "$t"
  else
    add "skill:$y" "$(printf '' | h)"
  fi
done
printf '{"install_id":"%s","files":[%s]}\\n' "$id" "$out"
`;
}

export function checkPs1(): string {
  return `# Docket tasklite-check (Agent files). Hashes the installed agent files, compares
# them with .tasklite-manifest.json, and prints the report to pass as instructions
# on claim_lead: one line of JSON, with the text only of files that differ.
# It reads only: it writes and downloads nothing.
param([string]$Dir)
$ErrorActionPreference = 'Stop'
if (-not $Dir) { $Dir = $PSScriptRoot }
$here = (Resolve-Path -LiteralPath $Dir).ProviderPath
$base = Split-Path -Parent $here
$m = Join-Path $here '.tasklite-manifest.json'
if (-not (Test-Path -LiteralPath $m -PathType Leaf)) { throw "No Docket install found: $m is missing." }
$enc = [Text.Encoding]::GetEncoding(28591)
$utf8 = New-Object Text.UTF8Encoding $false
$B = '${DOCKET_BEGIN}'
$E = '${DOCKET_END}'
$ord = [StringComparison]::Ordinal
$sha = [Security.Cryptography.SHA256]::Create()
function TlHash([string]$s) { -join ($sha.ComputeHash($enc.GetBytes($s)) | ForEach-Object { $_.ToString('x2') }) }
$j = [IO.File]::ReadAllText($m) | ConvertFrom-Json
$out = New-Object System.Collections.ArrayList
$known = @($j.files | ForEach-Object { $_.key })
function Add-File([string]$k, [string]$x, [bool]$withText) {
  $e = [ordered]@{ key = $k; sha256 = (TlHash $x) }
  if ($withText) {
    $t = $utf8.GetString($enc.GetBytes($x))
    if ($t.Length -le 50000) { $e.content = $t }
  }
  [void]$out.Add($e)
}
foreach ($r in $j.files) {
  $f = Join-Path $base $r.path
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
  $x = $enc.GetString([IO.File]::ReadAllBytes($f)).Replace("\`r", '')
  if ($r.key -eq 'agents_block') {
    $i = $x.IndexOf($B, $ord); $k = $x.IndexOf($E, $ord)
    if ($i -lt 0 -or $k -lt $i) { continue }
    $x = $x.Substring($i + $B.Length, $k - $i - $B.Length)
    if ($x.StartsWith("\`n", $ord)) { $x = $x.Substring(1) }
    if ($x.EndsWith("\`n", $ord)) { $x = $x.Substring(0, $x.Length - 1) }
  }
  Add-File $r.key $x ((TlHash $x) -ne $r.sha256)
}
$sk = Join-Path $here 'skills'
if (Test-Path -LiteralPath $sk) {
  foreach ($d in (Get-ChildItem -LiteralPath $sk -Directory -Force -Filter 'tasklite-*' | Sort-Object Name)) {
    $y = $d.Name
    if ($y -cnotmatch '^[a-z0-9-]{1,60}$' -or $known -contains ('skill:' + $y)) { continue }
    if ($out.Count -ge 20) { break }
    $f = Join-Path $d.FullName 'SKILL.md'
    if (Test-Path -LiteralPath $f -PathType Leaf) {
      Add-File ('skill:' + $y) ($enc.GetString([IO.File]::ReadAllBytes($f)).Replace("\`r", '')) $true
    } else {
      Add-File ('skill:' + $y) '' $false
    }
  }
}
$o = [ordered]@{ install_id = $j.install_id; files = @($out) }
$json = ConvertTo-Json -InputObject $o -Depth 4 -Compress
[regex]::Replace($json, '[^\\x00-\\x7F]', { param($c) '\\u{0:x4}' -f [int][char]$c.Value })
`;
}
