/**
 * The connection-file scanners for the shells (owner decision 32; BUILD_SPEC
 * §5.17a): the same rules as `scanJson`, `scanToml` and `installedConnection`
 * in connection.ts, for the command install's step (`install.sh`,
 * `install.ps1`) and the copy-paste check commands. They need nothing but the
 * shell: POSIX awk for bash, and PowerShell 5.1 or 7.
 *
 * **awk** (`CONNECTION_AWK`, one top-level item per line, no single quotes,
 * so it fits in a single-quoted bash string or a `printf` list). Run as
 * `awk -v mode=json|toml -v out=pos|canon -f - FILE`, with `LC_ALL=C`:
 * - `out=pos` prints one line: `err <detail>`, or for JSON
 *   `ok <nonEmpty> <topOpen> <topClose> <topEmpty> <srvOpen> <srvClose>
 *   <srvEmpty> <dkStart> <dkEnd>`, for TOML `ok <hdrStart> <regionEnd>`
 *   (0-based byte offsets, -1 for none; booleans 0 or 1);
 * - `out=canon` prints the canonical `docket` entry with no newline, or
 *   `!absent`, or `!invalid`.
 *
 * **PowerShell** (`CONNECTION_PS1`): `DkJson $text`, `DkToml $text` (each a
 * hashtable like the TS scans: `ok`, `error`, and the offsets) and
 * `DkCanon $client $text` (the canonical text, `$null` when absent, or
 * `'!invalid'`). Written so that its lines joined with `; ` still parse
 * (no comments, `} else {` on one line), for the one-line check command.
 * Text is read as latin1, as the other install steps do, so offsets are bytes.
 */

/** awk: one top-level item per element (each a single line). */
const AWK_ITEMS: string[] = [
  String.raw`BEGIN { BINMODE = 3; for (k = 1; k < 32; k++) ctl = ctl sprintf("%c", k); q = "\""; sq = sprintf("%c", 39); bs = "\\"; lit = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+-"; kp = "([A-Za-z0-9_-]+|\"[^\"]*\"|" sq "[^" sq "]*" sq ")"; keyre = "^" kp "([ \t]*[.][ \t]*" kp ")*[ \t]*="; s = ""; first = 1 }`,
  String.raw`{ if (first) { s = $0; first = 0 } else { s = s "\n" $0 } }`,
  String.raw`function fail(m) { if (out == "canon") printf "!invalid"; else print "err " m; exit 0 }`,
  // ---- JSON ----
  String.raw`function jafter(e) { if (dktrack && sp == 2) { dkend = e; dktrack = 0 } st = (sp == 0) ? "E" : "C" }`,
  String.raw`function jvstart(i, c) { if (sp == 0 && c != "{") fail("not an object"); if (sp == 1 && key1 == "\"mcpServers\"") { if (srvopen >= 0) fail("mcpServers appears twice"); if (c != "{") fail("mcpServers is not an object"); srvopen = i - 1; insrv = 1 } else if (sp == 2 && insrv && key2 == "\"docket\"") { if (dkstart >= 0) fail("docket appears twice"); dkstart = i - 1; dktrack = 1 } }`,
  String.raw`function jclose(i, c,   want) { want = (c == "}") ? "o" : "a"; if (sp < 1 || stk[sp] != want) fail("mismatched bracket"); if (insrv && sp == 2) { srvclose = i - 1; insrv = 0 } sp--; if (sp == 0) topclose = i - 1; jafter(i) }`,
  String.raw`function jstr(i,   j, d) { j = i + 1; while (j <= n) { d = substr(s, j, 1); if (d == bs) { j += 2; continue } if (d == q) break; if (index(ctl, d)) fail("control character in a string"); j++ } if (j > n) fail("unclosed string"); return j + 1 }`,
  String.raw`function json(   i, c, j, key, tok) { st = "V"; sp = 0; key1 = ""; key2 = ""; topopen = -1; topclose = -1; topempty = 1; srvopen = -1; srvclose = -1; srvempty = 1; insrv = 0; dkstart = -1; dkend = -1; dktrack = 0; nonempty = 0; i = 1; while (i <= n) { c = substr(s, i, 1); if (c == " " || c == "\t" || c == "\n" || c == "\r") { i++; continue } nonempty = 1; if (st == "E") fail("text after the end"); if (st == "V" || st == "A") { if (st == "A" && c == "]") { jclose(i, c); i++; continue } jvstart(i, c); if (c == "{" || c == "[") { if (sp == 0) topopen = i - 1; sp++; stk[sp] = (c == "{") ? "o" : "a"; st = (c == "{") ? "K" : "A"; i++ } else if (c == q) { i = jstr(i); jafter(i - 1) } else { j = i; while (j <= n && index(lit, substr(s, j, 1))) j++; if (j == i) fail("unexpected character"); tok = substr(s, i, j - i); if (tok !~ /^(true|false|null|-?(0|[1-9][0-9]*)([.][0-9]+)?([eE][+-]?[0-9]+)?)$/) fail("unexpected value"); i = j; jafter(i - 1) } continue } if (st == "K" || st == "Q") { if (st == "K" && c == "}") { jclose(i, c); i++; continue } if (c != q) fail("unexpected character"); j = jstr(i); key = substr(s, i, j - i); if (sp == 1) { key1 = key; topempty = 0 } else if (sp == 2 && insrv) { key2 = key; srvempty = 0 } i = j; st = "L"; continue } if (st == "L") { if (c != ":") fail("unexpected character"); st = "V"; i++; continue } if (c == ",") { st = (stk[sp] == "o") ? "Q" : "V"; i++ } else if (c == "}" || c == "]") { jclose(i, c); i++ } else fail("unexpected character") } if (nonempty && st != "E") fail("ends early") }`,
  String.raw`function jcompact(from, to,   i, c, o, instr) { o = ""; instr = 0; for (i = from + 1; i <= to; i++) { c = substr(s, i, 1); if (instr) { o = o c; if (c == bs) { i++; o = o substr(s, i, 1) } else if (c == q) instr = 0 } else if (c == q) { instr = 1; o = o c } else if (c != " " && c != "\t" && c != "\n" && c != "\r") o = o c } return o }`,
  // ---- TOML ----
  String.raw`function trim(t) { sub(/^[ \t\r]+/, "", t); sub(/[ \t\r]+$/, "", t); return t }`,
  String.raw`function nkey(k,   parts, m, i, p, o) { m = split(k, parts, "."); o = ""; for (i = 1; i <= m; i++) { p = trim(parts[i]); if (length(p) >= 2 && ((substr(p, 1, 1) == q && substr(p, length(p), 1) == q) || (substr(p, 1, 1) == sq && substr(p, length(p), 1) == sq))) p = substr(p, 2, length(p) - 2); o = (i == 1) ? p : o "." p } return o }`,
  String.raw`function tvalue(line, from,   i, c, d, cl, j, rest) { i = from; while (i <= length(line)) { c = substr(line, i, 1); if (c == "#") return; d = substr(line, i, 3); if (d == q q q || d == sq sq sq) { rest = substr(line, i + 3); cl = index(rest, d); if (cl == 0) { ml = d; return } i = i + 3 + cl - 1 + 3 } else if (c == q) { j = i + 1; while (j <= length(line) && substr(line, j, 1) != q) j += (substr(line, j, 1) == bs) ? 2 : 1; if (j > length(line)) fail("unclosed string"); i = j + 1 } else if (c == sq) { rest = substr(line, i + 1); j = index(rest, sq); if (j == 0) fail("unclosed string"); i = i + j + 1 } else { if (c == "[" || c == "{") depth++; if (c == "]" || c == "}") depth--; if (depth < 0) fail("unexpected bracket"); i++ } } }`,
  String.raw`function theader(t,   arr, rest, p, after) { arr = (substr(t, 1, 2) == "[[") ? 1 : 0; rest = substr(t, arr ? 3 : 2); p = index(rest, "]"); if (p <= 1) return ""; hname = substr(rest, 1, p - 1); if (index(hname, "[")) return ""; after = substr(rest, p); if (arr) { if (substr(after, 1, 2) != "]]") return ""; after = substr(after, 3) } else after = substr(after, 2); sub(/^[ \t]+/, "", after); if (after != "" && substr(after, 1, 1) != "#") return ""; return arr ? "array" : "table" }`,
  String.raw`function toml(   nl, L, st0, n0, at, t, h, key, full, indk, last, cl, rest) { ml = ""; depth = 0; table = ""; hdr = -1; endi = -1; nl = split(s, L, "\n"); if (s == "") nl = 0; at = 0; for (n0 = 1; n0 <= nl; n0++) { st0[n0] = at; at += length(L[n0]) + 1 } for (n0 = 1; n0 <= nl; n0++) { if (ml != "") { kind[n0] = "cont"; cl = index(L[n0], ml); if (cl > 0) { ml = ""; tvalue(L[n0], cl + 3) } continue } if (depth > 0) { kind[n0] = "cont"; tvalue(L[n0], 1); continue } t = trim(L[n0]); if (t == "") { kind[n0] = "blank"; continue } if (substr(t, 1, 1) == "#") { kind[n0] = "comment"; continue } if (substr(t, 1, 1) == "[") { h = theader(t); if (h == "") fail("bad table header on line " n0); kind[n0] = "header"; table = nkey(hname); if (hdr >= 0 && endi < 0) endi = n0; if (table == "mcp_servers.docket" && h == "table") { if (hdr >= 0) fail("docket table twice"); hdr = n0 } continue } if (!match(t, keyre)) fail("bad line " n0); kind[n0] = "key"; key = nkey(substr(t, 1, RLENGTH - 1)); full = (table == "") ? key : table "." key; indk = (table == "mcp_servers.docket" || index(table, "mcp_servers.docket.") == 1); if ((full == "mcp_servers.docket" || index(full, "mcp_servers.docket.") == 1) && !indk) fail("docket defined another way"); tvalue(t, RLENGTH + 1) } if (ml != "") fail("unclosed string"); if (depth != 0) fail("unclosed bracket"); if (hdr < 0) { tstart = -1; tend = -1; return } if (endi < 0) endi = nl + 1; last = endi - 1; while (last > hdr && (kind[last] == "blank" || kind[last] == "comment")) last--; tstart = st0[hdr]; tend = st0[last] + length(L[last]) + 1; tfrom = hdr; tto = endi - 1; for (n0 = 1; n0 <= nl; n0++) TL[n0] = L[n0] }`,
  String.raw`function tcanon(   i, t, o) { o = ""; for (i = tfrom; i <= tto; i++) { t = trim(TL[i]); if (t == "" || substr(t, 1, 1) == "#") continue; o = (o == "") ? t : o "\n" t } return o }`,
  String.raw`END { n = length(s); if (mode == "toml") { toml(); if (out == "canon") { if (tstart < 0) printf "!absent"; else printf "%s", tcanon() } else print "ok " tstart " " tend } else { json(); if (out == "canon") { if (dkstart < 0) printf "!absent"; else printf "%s", jcompact(dkstart, dkend) } else print "ok " nonempty " " topopen " " topclose " " topempty " " srvopen " " srvclose " " srvempty " " dkstart " " dkend } }`,
];

/** The awk program, one item per line (no `'`, so it fits in single quotes). */
export const CONNECTION_AWK = AWK_ITEMS.join('\n');
export const CONNECTION_AWK_ITEMS: readonly string[] = AWK_ITEMS;

/** PowerShell: the scanners, as lines that still parse when joined with `; `. */
const PS_LINES: string[] = [
  String.raw`function DkFail([string]$m) { throw ('dk:' + $m) }`,
  String.raw`function DkAfter($z, [int]$e) {`,
  String.raw`if ($z.dktrack -and $z.stack.Count -eq 2) { $z.dkEnd = $e; $z.dktrack = $false }`,
  String.raw`if ($z.stack.Count -eq 0) { $z.st = 'E' } else { $z.st = 'C' }`,
  String.raw`}`,
  String.raw`function DkClose($z, [int]$i, [string]$c) {`,
  String.raw`$want = 'a'; if ($c -ceq '}') { $want = 'o' }`,
  String.raw`if ($z.stack.Count -lt 1 -or $z.stack[$z.stack.Count - 1] -cne $want) { DkFail 'mismatched bracket' }`,
  String.raw`if ($z.insrv -and $z.stack.Count -eq 2) { $z.srvClose = $i; $z.insrv = $false }`,
  String.raw`$z.stack.RemoveAt($z.stack.Count - 1)`,
  String.raw`if ($z.stack.Count -eq 0) { $z.topClose = $i }`,
  String.raw`DkAfter $z ($i + 1)`,
  String.raw`}`,
  String.raw`function DkStr([string]$s, [int]$i) {`,
  String.raw`$j = $i + 1; $n = $s.Length`,
  String.raw`while ($j -lt $n) { $d = $s[$j]; if ($d -ceq '\') { $j += 2; continue }; if ($d -ceq '"') { break }; if ([int]$d -lt 32) { DkFail 'control character in a string' }; $j++ }`,
  String.raw`if ($j -ge $n) { DkFail 'unclosed string' }`,
  String.raw`return ($j + 1)`,
  String.raw`}`,
  String.raw`function DkJson([string]$s) {`,
  String.raw`$z = @{ st = 'V'; stack = (New-Object System.Collections.ArrayList); key1 = ''; key2 = ''; topOpen = -1; topClose = -1; topEmpty = $true; srvOpen = -1; srvClose = -1; srvEmpty = $true; insrv = $false; dkStart = -1; dkEnd = -1; dktrack = $false; nonEmpty = $false; ok = $true; error = $null }`,
  String.raw`$lit = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+-'; $n = $s.Length; $i = 0`,
  String.raw`try {`,
  String.raw`while ($i -lt $n) {`,
  String.raw`$c = [string]$s[$i]`,
  String.raw`if ($c -ceq ' ' -or $c -ceq [string][char]9 -or $c -ceq [string][char]10 -or $c -ceq [string][char]13) { $i++; continue }`,
  String.raw`$z.nonEmpty = $true`,
  String.raw`if ($z.st -ceq 'E') { DkFail 'text after the end' }`,
  String.raw`if ($z.st -ceq 'V' -or $z.st -ceq 'A') {`,
  String.raw`if ($z.st -ceq 'A' -and $c -ceq ']') { DkClose $z $i $c; $i++; continue }`,
  String.raw`if ($z.stack.Count -eq 0 -and $c -cne '{') { DkFail 'not an object' }`,
  String.raw`if ($z.stack.Count -eq 1 -and $z.key1 -ceq '"mcpServers"') { if ($z.srvOpen -ge 0) { DkFail 'mcpServers appears twice' }; if ($c -cne '{') { DkFail 'mcpServers is not an object' }; $z.srvOpen = $i; $z.insrv = $true } elseif ($z.stack.Count -eq 2 -and $z.insrv -and $z.key2 -ceq '"docket"') { if ($z.dkStart -ge 0) { DkFail 'docket appears twice' }; $z.dkStart = $i; $z.dktrack = $true }`,
  String.raw`if ($c -ceq '{' -or $c -ceq '[') { if ($z.stack.Count -eq 0) { $z.topOpen = $i }; if ($c -ceq '{') { [void]$z.stack.Add('o'); $z.st = 'K' } else { [void]$z.stack.Add('a'); $z.st = 'A' }; $i++ } elseif ($c -ceq '"') { $i = DkStr $s $i; DkAfter $z $i } else { $j = $i; while ($j -lt $n -and $lit.IndexOf([string]$s[$j], [StringComparison]::Ordinal) -ge 0) { $j++ }; if ($j -eq $i) { DkFail 'unexpected character' }; if ($s.Substring($i, $j - $i) -cnotmatch '^(true|false|null|-?(0|[1-9][0-9]*)([.][0-9]+)?([eE][+-]?[0-9]+)?)$') { DkFail 'unexpected value' }; $i = $j; DkAfter $z $i }`,
  String.raw`continue`,
  String.raw`}`,
  String.raw`if ($z.st -ceq 'K' -or $z.st -ceq 'Q') {`,
  String.raw`if ($z.st -ceq 'K' -and $c -ceq '}') { DkClose $z $i $c; $i++; continue }`,
  String.raw`if ($c -cne '"') { DkFail 'unexpected character' }`,
  String.raw`$j = DkStr $s $i; $key = $s.Substring($i, $j - $i)`,
  String.raw`if ($z.stack.Count -eq 1) { $z.key1 = $key; $z.topEmpty = $false } elseif ($z.stack.Count -eq 2 -and $z.insrv) { $z.key2 = $key; $z.srvEmpty = $false }`,
  String.raw`$i = $j; $z.st = 'L'; continue`,
  String.raw`}`,
  String.raw`if ($z.st -ceq 'L') { if ($c -cne ':') { DkFail 'unexpected character' }; $z.st = 'V'; $i++; continue }`,
  String.raw`if ($c -ceq ',') { if ($z.stack[$z.stack.Count - 1] -ceq 'o') { $z.st = 'Q' } else { $z.st = 'V' }; $i++ } elseif ($c -ceq '}' -or $c -ceq ']') { DkClose $z $i $c; $i++ } else { DkFail 'unexpected character' }`,
  String.raw`}`,
  String.raw`if ($z.nonEmpty -and $z.st -cne 'E') { DkFail 'ends early' }`,
  String.raw`} catch { $m = [string]$_.Exception.Message; if (-not $m.StartsWith('dk:')) { throw }; $z.ok = $false; $z.error = $m.Substring(3) }`,
  String.raw`return $z`,
  String.raw`}`,
  String.raw`function DkCompact([string]$s, [int]$from, [int]$to) {`,
  String.raw`$o = New-Object System.Text.StringBuilder; $in = $false; $i = $from`,
  String.raw`while ($i -lt $to) { $c = [string]$s[$i]; if ($in) { [void]$o.Append($c); if ($c -ceq '\') { $i++; if ($i -lt $s.Length) { [void]$o.Append([string]$s[$i]) } } elseif ($c -ceq '"') { $in = $false } } elseif ($c -ceq '"') { $in = $true; [void]$o.Append($c) } elseif (-not ($c -ceq ' ' -or $c -ceq [string][char]9 -or $c -ceq [string][char]10 -or $c -ceq [string][char]13)) { [void]$o.Append($c) }; $i++ }`,
  String.raw`return $o.ToString()`,
  String.raw`}`,
  String.raw`function DkTrim([string]$t) { return $t.Trim([char[]]@([char]32, [char]9, [char]13)) }`,
  String.raw`function DkKey([string]$k) { $parts = @(); foreach ($p in $k.Split('.')) { $p = DkTrim $p; if ($p.Length -ge 2 -and (($p.StartsWith('"') -and $p.EndsWith('"')) -or ($p.StartsWith("'") -and $p.EndsWith("'")))) { $p = $p.Substring(1, $p.Length - 2) }; $parts += $p }; return ($parts -join '.') }`,
  String.raw`function DkValue($z, [string]$line, [int]$from) {`,
  String.raw`$i = $from; $q3 = '"""'; $s3 = "'''"`,
  String.raw`while ($i -lt $line.Length) {`,
  String.raw`$c = [string]$line[$i]`,
  String.raw`if ($c -ceq '#') { return }`,
  String.raw`$d = ''; if ($i + 3 -le $line.Length) { $d = $line.Substring($i, 3) }`,
  String.raw`if ($d -ceq $q3 -or $d -ceq $s3) { $cl = $line.IndexOf($d, $i + 3, [StringComparison]::Ordinal); if ($cl -lt 0) { $z.ml = $d; return }; $i = $cl + 3 } elseif ($c -ceq '"') { $j = $i + 1; while ($j -lt $line.Length -and [string]$line[$j] -cne '"') { if ([string]$line[$j] -ceq '\') { $j += 2 } else { $j++ } }; if ($j -ge $line.Length) { DkFail 'unclosed string' }; $i = $j + 1 } elseif ($c -ceq "'") { $j = $line.IndexOf("'", $i + 1, [StringComparison]::Ordinal); if ($j -lt 0) { DkFail 'unclosed string' }; $i = $j + 1 } else { if ($c -ceq '[' -or $c -ceq '{') { $z.depth++ }; if ($c -ceq ']' -or $c -ceq '}') { $z.depth-- }; if ($z.depth -lt 0) { DkFail 'unexpected bracket' }; $i++ }`,
  String.raw`}`,
  String.raw`}`,
  String.raw`function DkHeader([string]$t) {`,
  String.raw`$arr = $t.StartsWith('[['); if ($arr) { $rest = $t.Substring(2) } else { $rest = $t.Substring(1) }`,
  String.raw`$p = $rest.IndexOf(']'); if ($p -le 0) { return $null }`,
  String.raw`$name = $rest.Substring(0, $p); if ($name.Contains('[')) { return $null }`,
  String.raw`$after = $rest.Substring($p); if ($arr) { if (-not $after.StartsWith(']]')) { return $null }; $after = $after.Substring(2) } else { $after = $after.Substring(1) }`,
  String.raw`$after = $after.TrimStart([char[]]@([char]32, [char]9)); if ($after -cne '' -and -not $after.StartsWith('#')) { return $null }`,
  String.raw`return @{ array = $arr; name = $name }`,
  String.raw`}`,
  String.raw`function DkToml([string]$s) {`,
  String.raw`$z = @{ ok = $true; error = $null; hdrStart = -1; regionEnd = -1; lines = @(); ml = ''; depth = 0 }`,
  String.raw`$kp = '([A-Za-z0-9_-]+|"[^"]*"|''[^'']*'')'; $keyre = '^' + $kp + '([ \t]*[.][ \t]*' + $kp + ')*[ \t]*='; $dt = 'mcp_servers.docket'`,
  String.raw`$tl = $s.Split([char]10); $starts = @(); $at = 0; foreach ($one in $tl) { $starts += $at; $at += $one.Length + 1 }`,
  String.raw`$kinds = @(); $table = ''; $hdr = -1; $endi = -1`,
  String.raw`try {`,
  String.raw`for ($n = 0; $n -lt $tl.Length; $n++) {`,
  String.raw`$line = $tl[$n]`,
  String.raw`if ($z.ml -cne '') { $kinds += 'cont'; $cl = $line.IndexOf($z.ml, [StringComparison]::Ordinal); if ($cl -ge 0) { $z.ml = ''; DkValue $z $line ($cl + 3) }; continue }`,
  String.raw`if ($z.depth -gt 0) { $kinds += 'cont'; DkValue $z $line 0; continue }`,
  String.raw`$t = DkTrim $line`,
  String.raw`if ($t -ceq '') { $kinds += 'blank'; continue }`,
  String.raw`if ($t.StartsWith('#')) { $kinds += 'comment'; continue }`,
  String.raw`if ($t.StartsWith('[')) { $h = DkHeader $t; if ($null -eq $h) { DkFail ('bad table header on line ' + ($n + 1)) }; $kinds += 'header'; $table = DkKey $h.name; if ($hdr -ge 0 -and $endi -lt 0) { $endi = $n }; if ($table -ceq $dt -and -not $h.array) { if ($hdr -ge 0) { DkFail 'docket table twice' }; $hdr = $n; $z.hdrStart = $starts[$n] }; continue }`,
  String.raw`$m = [regex]::Match($t, $keyre); if (-not $m.Success) { DkFail ('bad line ' + ($n + 1)) }`,
  String.raw`$kinds += 'key'; $key = DkKey $m.Value.Substring(0, $m.Value.Length - 1); if ($table -ceq '') { $full = $key } else { $full = $table + '.' + $key }`,
  String.raw`$indk = ($table -ceq $dt) -or $table.StartsWith($dt + '.', [StringComparison]::Ordinal)`,
  String.raw`if ((($full -ceq $dt) -or $full.StartsWith($dt + '.', [StringComparison]::Ordinal)) -and -not $indk) { DkFail 'docket defined another way' }`,
  String.raw`DkValue $z $t $m.Value.Length`,
  String.raw`}`,
  String.raw`if ($z.ml -cne '') { DkFail 'unclosed string' }`,
  String.raw`if ($z.depth -ne 0) { DkFail 'unclosed bracket' }`,
  String.raw`if ($hdr -ge 0) { if ($endi -lt 0) { $endi = $tl.Length }; $last = $endi - 1; while ($last -gt $hdr -and ($kinds[$last] -ceq 'blank' -or $kinds[$last] -ceq 'comment')) { $last-- }; $z.regionEnd = $starts[$last] + $tl[$last].Length + 1; $z.lines = @($tl[$hdr..($endi - 1)]) }`,
  String.raw`} catch { $m = [string]$_.Exception.Message; if (-not $m.StartsWith('dk:')) { throw }; $z.ok = $false; $z.error = $m.Substring(3) }`,
  String.raw`return $z`,
  String.raw`}`,
  String.raw`function DkCanon([string]$client, [string]$s) {`,
  String.raw`if ($client -ceq 'codex') { $r = DkToml $s; if (-not $r.ok) { return '!invalid' }; if ($r.hdrStart -lt 0) { return $null }; $o = @(); foreach ($l in $r.lines) { $t = DkTrim $l; if ($t -cne '' -and -not $t.StartsWith('#')) { $o += $t } }; return ($o -join [string][char]10) }`,
  String.raw`$r = DkJson $s; if (-not $r.ok) { return '!invalid' }; if ($r.dkStart -lt 0) { return $null }; return (DkCompact $s $r.dkStart $r.dkEnd)`,
  String.raw`}`,
];

/** The PowerShell scanners, one statement per line. */
export const CONNECTION_PS1 = PS_LINES.join('\n');
/** The same, on one line (for the copy-paste check command). */
export const CONNECTION_PS1_ONE_LINE = PS_LINES.join('; ');
