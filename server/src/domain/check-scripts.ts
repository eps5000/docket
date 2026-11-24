/**
 * The installed `docket-check` script (owner decision 30; BUILD_SPEC
 * §5.19; T161): `docket-check.sh` (bash) and `docket-check.ps1`
 * (PowerShell 5.1 and 7), installed next to the manifest (`.claude/` or
 * `.codex/`, in the repo or the home folder) by both install methods.
 *
 * It hashes each installed file exactly as B24's check does
 * (`checkCommands` in @docket/shared, `inspectPushInstall` on the server):
 * CR bytes removed, and the AGENTS.md block as the text between the Docket
 * markers less one newline at each end. It compares each hash with the
 * manifest and prints one line of JSON, the `instructions` argument of
 * `claim_lead`:
 *
 *     {"install_id":"ins_…","files":[{"key":"skill:docket-worker","sha256":"…"}, …]}
 *
 * - a file that matches is listed with its hash only, so a typical report is
 *   a few hundred characters;
 * - a file that differs also carries its text (`content`, up to 50,000
 *   characters; longer text is left out), for the owner's diff and *Adopt*;
 * - a missing file is left out: Docket reads its absence as missing;
 * - an extra `docket-*` skill folder is listed as `skill:<name>` with its
 *   `SKILL.md` text, and so is an old `tasklite-*` folder the manifest
 *   doesn't list (one an install kept because it was edited locally; B28);
 * - an install from before the rename has only `.tasklite-manifest.json`
 *   and the old markers: both are read when the new ones are absent;
 * - at most 60 files (`LIMITS.instruction_files_max`; 20 before skill
 *   references, decision 66), and only valid keys, so the report always
 *   passes `claim_lead`'s schema. A reference is reported like any file in
 *   the manifest;
 * - the connection file (`.mcp.json`, `.codex/config.toml`; decision 32) is
 *   left out: an agent that claims is connected, and the key isn't part of
 *   `claim_lead`'s contract. The push check, the scheduled drift check and
 *   the copy-paste check command cover it.
 *
 * It reads only: it writes, deletes and downloads nothing. ASCII only, so
 * PowerShell 5.1 reads it the same in any code page, and the PowerShell
 * version prints non-ASCII text as `\uXXXX` for the same reason.
 */
import {
  CONNECTION_KEY,
  DOCKET_BEGIN,
  DOCKET_END,
  INSTALL_MANIFEST_NAME,
  LEGACY_BEGIN,
  LEGACY_END,
  LEGACY_MANIFEST_NAME,
  LEGACY_SKILL_PREFIX,
  LIMITS,
} from '@docket/shared';

/** The most files a report holds: what `claim_lead`'s `instructions` accepts. */
const MAX_FILES = LIMITS.instruction_files_max;

/** The installed script's file names, next to the manifest. */
export const CHECK_SCRIPT_SH = 'docket-check.sh';
export const CHECK_SCRIPT_PS1 = 'docket-check.ps1';

/**
 * Every earlier `docket-check` Docket shipped (sha256, CR bytes removed). The
 * script isn't in the manifest, so this is how `docket-update` (decision 56)
 * tells an old copy, which it replaces, from a local edit, which it keeps.
 * **When you change the script, add the hash of the version you replaced.**
 */
export const SHIPPED_CHECK_SHA256: readonly string[] = [
  // Decision 66: a report holds up to 60 files.
  '4365b97a7b95f3f91f46be38c233294892a878817b09e24afa1ad4f37649c074',
  '3ba3017365a9a3c790db06b7d94999c523f92af7cbc8714246f7170143862900',
  '960dcca6f5f855cdd0be402bae84d5928a28044547773dfc13b7a34545c7fddf',
  '7d3f52c23c2b3295d36fa40c5410373ff12184ede347d42b88f4d30329f17d15',
  '710b3038313737d1b7a1a69697e5f57da51c8ce655a4b2bb5ce3e644f8672465',
  '9dc34467ecff19d7e74aa0b8265bd22f1a5b23546c23d6727d74864c60804d9a',
  'a1337fad26e46e2fc7990c67da39dc59399e69baa12f37278311802d5b3f3d8f',
  '023459b49d3109647e92efe8de827e10c6b3fd8322290b28de0c42a93ee02bde',
];

export function checkSh(): string {
  return `#!/usr/bin/env bash
# Docket docket-check (Agent files). Hashes the installed agent files, compares
# them with .docket-manifest.json, and prints the report to pass as instructions
# on claim_lead: one line of JSON, with the text only of files that differ.
# It reads only: it writes and downloads nothing.
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
base=$(dirname "$here")
m="$here/${INSTALL_MANIFEST_NAME}"
[ -f "$m" ] || { [ -f "$here/${LEGACY_MANIFEST_NAME}" ] && m="$here/${LEGACY_MANIFEST_NAME}"; }
B='${DOCKET_BEGIN}'
E='${DOCKET_END}'
OB='${LEGACY_BEGIN}'
OE='${LEGACY_END}'
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
  # The connection file isn't reported (decision 32): an agent that claims is connected.
  [ "$k" = ${CONNECTION_KEY} ] && continue
  # Nor are the installed scripts (decision 40): the push check and the check command cover them.
  case $k in script:*) continue ;; esac
  f="$base/$p"
  [ -f "$f" ] || continue
  if [ "$k" = agents_block ]; then
    x=$(cat "$f"; printf x); x=\${x%x}
    mb=$B; me=$E
    case $x in *"$B"*) ;; *) mb=$OB; me=$OE ;; esac
    case $x in *"$mb"*"$me"*) ;; *) continue ;; esac
    x=\${x#*"$mb"}; x=\${x%%"$me"*}; x=$(printf '%s' "$x" | tr -d '\\r'; printf x); x=\${x%x}; x=\${x#$'\\n'}; x=\${x%$'\\n'}
    printf '%s' "$x" > "$t"
  else
    tr -d '\\r' < "$f" > "$t"
  fi
  got=$(h < "$t")
  if [ "$got" = "$s" ]; then add "$k" "$got"; else add "$k" "$got" "$t"; fi
done < "$m"
for x in "$here"/skills/docket-*/ "$here"/skills/${LEGACY_SKILL_PREFIX}*/; do
  [ -d "$x" ] || continue
  y=\${x%/}; y=\${y##*/}
  case $y in *[!a-z0-9-]*) continue ;; esac
  [ \${#y} -le 60 ] || continue
  case $known in *" skill:$y "*) continue ;; esac
  [ "$n" -lt ${MAX_FILES} ] || break
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
  return `# Docket docket-check (Agent files). Hashes the installed agent files, compares
# them with .docket-manifest.json, and prints the report to pass as instructions
# on claim_lead: one line of JSON, with the text only of files that differ.
# It reads only: it writes and downloads nothing.
param([string]$Dir)
$ErrorActionPreference = 'Stop'
if (-not $Dir) { $Dir = $PSScriptRoot }
$here = (Resolve-Path -LiteralPath $Dir).ProviderPath
$base = Split-Path -Parent $here
$m = Join-Path $here '${INSTALL_MANIFEST_NAME}'
if (-not (Test-Path -LiteralPath $m -PathType Leaf)) {
  $o = Join-Path $here '${LEGACY_MANIFEST_NAME}'
  if (Test-Path -LiteralPath $o -PathType Leaf) { $m = $o }
}
if (-not (Test-Path -LiteralPath $m -PathType Leaf)) { throw "No Docket install found: $m is missing." }
$enc = [Text.Encoding]::GetEncoding(28591)
$utf8 = New-Object Text.UTF8Encoding $false
$B = '${DOCKET_BEGIN}'
$E = '${DOCKET_END}'
$OB = '${LEGACY_BEGIN}'
$OE = '${LEGACY_END}'
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
  if ($r.key -eq '${CONNECTION_KEY}' -or $r.key -like 'script:*') { continue }
  $f = Join-Path $base $r.path
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
  $x = $enc.GetString([IO.File]::ReadAllBytes($f)).Replace("\`r", '')
  if ($r.key -eq 'agents_block') {
    $mb = $B; $me = $E
    if ($x.IndexOf($B, $ord) -lt 0) { $mb = $OB; $me = $OE }
    $i = $x.IndexOf($mb, $ord); $k = $x.IndexOf($me, $ord)
    if ($i -lt 0 -or $k -lt $i) { continue }
    $x = $x.Substring($i + $mb.Length, $k - $i - $mb.Length)
    if ($x.StartsWith("\`n", $ord)) { $x = $x.Substring(1) }
    if ($x.EndsWith("\`n", $ord)) { $x = $x.Substring(0, $x.Length - 1) }
  }
  Add-File $r.key $x ((TlHash $x) -ne $r.sha256)
}
$sk = Join-Path $here 'skills'
if (Test-Path -LiteralPath $sk) {
  $dirs = @(Get-ChildItem -LiteralPath $sk -Directory -Force -Filter 'docket-*' | Sort-Object Name) + @(Get-ChildItem -LiteralPath $sk -Directory -Force -Filter '${LEGACY_SKILL_PREFIX}*' | Sort-Object Name)
  foreach ($d in $dirs) {
    $y = $d.Name
    if ($y -cnotmatch '^[a-z0-9-]{1,60}$' -or $known -contains ('skill:' + $y)) { continue }
    if ($out.Count -ge ${MAX_FILES}) { break }
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
