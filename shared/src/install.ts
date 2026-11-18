/**
 * Installing the agent files (owner decision 29; BUILD_SPEC §5.17; FR-124 to
 * FR-127): what the server, the bundle's install step, the check commands and
 * the UI must agree on byte for byte.
 *
 * - **Layout:** where each file goes for a client and target, relative to the
 *   install's base (the repo folder, or the home folder for user-wide).
 * - **The AGENTS.md block** as installed: the template's leading HTML comment
 *   stripped, `{{KEY}}` filled for a project's repo install, and the
 *   placeholders still left in it (the Install dialog warns about them).
 * - **The marked section** between `<!-- tasklite:begin -->` and
 *   `<!-- tasklite:end -->`: inserted, replaced, or appended with new markers,
 *   and nothing outside the markers changes. A file with a missing or
 *   repeated marker is refused, never guessed at.
 * - **Hashing for the check:** a file is compared with its CR bytes removed
 *   (a Windows checkout may add them), and the block is the text between the
 *   markers less one newline at each end. The manifest's `sha256` is the
 *   installed content's, so a skill's equals its version's sha256 and the
 *   block's is the rendered block's.
 * - **The copy-paste commands** (PowerShell and bash): install and check.
 *
 * Strings here are JavaScript strings. Callers that must keep a file's other
 * bytes exactly (the push install) decode it as latin1, which round-trips
 * every byte, and the markers are ASCII.
 */
import type { InstallClient, InstallTargetKind } from './enums.js';

export const DOCKET_BEGIN = '<!-- tasklite:begin -->';
export const DOCKET_END = '<!-- tasklite:end -->';

/** The manifest's file name, in the client's folder (`.claude/` or `.codex/`). */
export const INSTALL_MANIFEST_NAME = '.tasklite-manifest.json';

/** Each client's folder, relative to the base (the repo, or home for user-wide). */
const CLIENT_DIR: Record<InstallClient, string> = { claude: '.claude', codex: '.codex' };
/** Each client's instructions file: CLAUDE.md (Claude Code) or AGENTS.md (Codex). */
const INSTRUCTIONS_FILE: Record<InstallClient, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
};

export interface InstallLayout {
  /** `.claude` or `.codex`, relative to the base. */
  dir: string;
  /** The skills folder: `.claude/skills`. */
  skillsDir: string;
  /** The instructions file: `CLAUDE.md` in a repo, `.claude/CLAUDE.md` user-wide. */
  instructions: string;
  /** `.claude/.tasklite-manifest.json`. */
  manifest: string;
  /** How paths are shown: `` in a repo, `~/` user-wide. */
  display: string;
}

/**
 * Where the files go (BUILD_SPEC §5.17, V7). Paths are relative to the base,
 * with `/` separators:
 * - Claude Code: `.claude/skills/<name>/SKILL.md`, and the block in
 *   `CLAUDE.md` (repo) or `~/.claude/CLAUDE.md` (user-wide);
 * - Codex: `.codex/skills/<name>/SKILL.md`, and the block in `AGENTS.md`
 *   (repo) or `~/.codex/AGENTS.md` (user-wide).
 */
export function installLayout(client: InstallClient, target: InstallTargetKind): InstallLayout {
  const dir = CLIENT_DIR[client];
  const file = INSTRUCTIONS_FILE[client];
  return {
    dir,
    skillsDir: `${dir}/skills`,
    instructions: target === 'repo' ? file : `${dir}/${file}`,
    manifest: `${dir}/${INSTALL_MANIFEST_NAME}`,
    display: target === 'repo' ? '' : '~/',
  };
}

/** The path a file is installed at, relative to the base: `.claude/skills/tasklite-worker/SKILL.md`. */
export function installPathOf(layout: InstallLayout, key: string): string {
  if (key.startsWith('skill:')) return `${layout.skillsDir}/${key.slice('skill:'.length)}/SKILL.md`;
  return layout.instructions;
}

// ---- The AGENTS.md block ----

const LEADING_COMMENT = /^\s*<!--[\s\S]*?-->[ \t]*(\r?\n)*/;
const PLACEHOLDER = /\{\{[^{}\r\n]*\}\}/g;

/**
 * The block as installed: the template's leading HTML comment (its notes for
 * humans) removed, `{{KEY}}` filled with the project key when one is given,
 * and blank lines trimmed from both ends.
 */
export function renderAgentsBlock(content: string, projectKey: string | null): string {
  let out = content.replace(LEADING_COMMENT, '');
  if (projectKey) out = out.split('{{KEY}}').join(projectKey);
  return out.replace(/^(\s*\r?\n)+/, '').replace(/\s+$/, '');
}

/** Whether an install fills `{{KEY}}`: a repo install of one project. */
export function fillsProjectKey(target: InstallTargetKind, project: string | null): string | null {
  return target === 'repo' && project ? project : null;
}

/** The `{{…}}` placeholders still in a block, each once, in order. */
export function placeholdersIn(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER) ?? [])];
}

// ---- The marked section ----

export type MarkedSection =
  | { kind: 'absent' }
  /** A missing or repeated marker: refused, never guessed at. */
  | { kind: 'broken' }
  /** `start` is the begin marker's index; `end` is just after the end marker. */
  | { kind: 'present'; start: number; end: number; inner: string };

/** Find the Task Lite section in a file's text. */
export function findMarkedSection(text: string): MarkedSection {
  const b = text.indexOf(DOCKET_BEGIN);
  const e = text.indexOf(DOCKET_END);
  if (b < 0 && e < 0) return { kind: 'absent' };
  if (b < 0 || e < b) return { kind: 'broken' };
  if (text.indexOf(DOCKET_BEGIN, b + 1) >= 0 || text.indexOf(DOCKET_END, e + 1) >= 0) {
    return { kind: 'broken' };
  }
  return {
    kind: 'present',
    start: b,
    end: e + DOCKET_END.length,
    inner: text.slice(b + DOCKET_BEGIN.length, e),
  };
}

export class BrokenMarkersError extends Error {
  constructor(file: string) {
    super(
      `${file} has a damaged Task Lite section: a ${DOCKET_BEGIN} or ${DOCKET_END} line is missing or repeated. Fix the markers, then install again.`,
    );
    this.name = 'BrokenMarkersError';
  }
}

/** The section as written: the markers on their own lines around the block. */
export const markedSection = (block: string): string =>
  `${DOCKET_BEGIN}\n${block}\n${DOCKET_END}`;

/**
 * Insert or replace the Task Lite section in `existing` (null: no file yet).
 * Everything before the begin marker and after the end marker stays exactly
 * as it was. Without markers the section is appended after a blank line, so
 * the old text is an exact prefix of the new. Throws `BrokenMarkersError`.
 */
export function mergeMarkedSection(
  existing: string | null,
  block: string,
  file = 'The instructions file',
): { text: string; how: 'created' | 'replaced' | 'appended' } {
  const section = markedSection(block);
  if (existing === null) return { text: `${section}\n`, how: 'created' };
  const found = findMarkedSection(existing);
  if (found.kind === 'broken') throw new BrokenMarkersError(file);
  if (found.kind === 'present') {
    return {
      text: existing.slice(0, found.start) + section + existing.slice(found.end),
      how: 'replaced',
    };
  }
  if (existing === '') return { text: `${section}\n`, how: 'appended' };
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${existing}${sep}${section}\n`, how: 'appended' };
}

/** Remove CR bytes: what the check hashes, so a Windows checkout reads as unchanged. */
export const withoutCr = (text: string): string => text.replace(/\r/g, '');

/**
 * The block as the check hashes it: the section's inner text without CRs,
 * less one newline at each end. Null without a section; `broken` for
 * damaged markers.
 */
export function installedBlock(text: string): string | null | 'broken' {
  const found = findMarkedSection(text);
  if (found.kind === 'absent') return null;
  if (found.kind === 'broken') return 'broken';
  let inner = withoutCr(found.inner);
  if (inner.startsWith('\n')) inner = inner.slice(1);
  if (inner.endsWith('\n')) inner = inner.slice(0, -1);
  return inner;
}

// ---- The copy-paste commands ----

/** Single-quote for bash: `'it'\''s'`. */
export const bashQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** Single-quote for PowerShell: `'it''s'` (and the typographic quotes it also honours). */
export const psQuote = (s: string): string => `'${s.replace(/['‘’‚‛]/g, (q) => q + q)}'`;

/** Control characters (newlines, NUL, escapes): never in a path we put in a command. */
export const hasControlChars = (s: string): boolean =>
  [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
/** A path the owner typed is put in a command only without control characters. */
export const isSafeCommandPath = (s: string): boolean => !hasControlChars(s);

export interface InstallCommandInput {
  client: InstallClient;
  target_kind: InstallTargetKind;
  /** The folder to install into; omitted: the current folder (repo) or home (user-wide). */
  path?: string | null | undefined;
}

const REFUSED =
  'Task Lite refused the download: this command was already used or is more than 10 minutes old. Make a new one in Agent files.';

function bashBase({ target_kind, path }: InstallCommandInput): string {
  if (target_kind === 'user') return '"$HOME"';
  return path ? bashQuote(path) : '"$PWD"';
}

function psBase({ target_kind, path }: InstallCommandInput): string {
  if (target_kind === 'user') return '$HOME';
  return path ? `(Resolve-Path -LiteralPath ${psQuote(path)}).ProviderPath` : '$PWD.ProviderPath';
}

/**
 * The install one-liners: download the bundle once, unpack it into a
 * temporary folder, run its install step (which copies the files and merges
 * the marked section), and remove the temporary folder. A repo install
 * refuses a folder without `.git`, before the download uses the token.
 */
export function installCommands(input: InstallCommandInput & { url: string }): {
  powershell: string;
  bash: string;
} {
  const repo = input.target_kind === 'repo';
  const bash = [
    `( set -e; d=${bashBase(input)}`,
    ...(repo
      ? [
          `[ -e "$d/.git" ] || { echo "Run this from the repo folder: there is no .git in $d" >&2; exit 1; }`,
        ]
      : []),
    `t=$(mktemp -d); trap 'rm -rf "$t"' EXIT`,
    `curl -fsS --noproxy '*' -o "$t/b.tgz" ${bashQuote(input.url)} || { echo ${bashQuote(REFUSED)} >&2; exit 1; }`,
    `tar -xzf "$t/b.tgz" -C "$t"`,
    `bash "$t/tasklite-install/install.sh" "$d" )`,
  ].join('; ');
  const powershell = [
    `& { $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $d = ${psBase(input)}`,
    ...(repo
      ? [
          `if (-not (Test-Path -LiteralPath (Join-Path $d '.git'))) { throw "Run this from the repo folder: there is no .git in $d" }`,
        ]
      : []),
    `$t = Join-Path ([IO.Path]::GetTempPath()) ('tasklite-' + [guid]::NewGuid()); New-Item -ItemType Directory -Path $t | Out-Null`,
    `try { $b = Join-Path $t 'b.tgz'; try { Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(input.url)} -OutFile $b } catch { throw ${psQuote(REFUSED)} }`,
    // Windows' own tar.exe: a GNU tar from Git on the PATH would read `C:` as a remote host.
    `$x = 'tar'; if ($env:SystemRoot) { $w = Join-Path $env:SystemRoot 'System32/tar.exe'; if (Test-Path -LiteralPath $w) { $x = $w } }; & $x -xzf $b -C $t; if ($LASTEXITCODE) { throw 'Could not unpack the download.' }`,
    `$i = Join-Path (Join-Path $t 'tasklite-install') 'install.ps1'; & ([scriptblock]::Create((Get-Content -Raw -LiteralPath $i))) (Join-Path $t 'tasklite-install') $d } finally { Remove-Item -Recurse -Force -LiteralPath $t } }`,
  ].join('; ');
  return { powershell, bash };
}

/**
 * The check one-liners (FR-127, without push): read the manifest the install
 * left, hash each file as the check defines it, and print the files that
 * were edited locally, are missing, or are extra `tasklite-*` skill folders,
 * each with the version Task Lite sent. They download nothing and need no
 * token. Run them where the install ran (the repo folder, for a repo).
 */
export function checkCommands(input: InstallCommandInput): { powershell: string; bash: string } {
  const layout = installLayout(input.client, input.target_kind);
  const disp = layout.display;
  const bash = [
    `( d=${bashBase(input)}; m="$d/${layout.manifest}"; B='${DOCKET_BEGIN}'; E='${DOCKET_END}'`,
    `[ -f "$m" ] || { echo "No Task Lite install found: $m is missing." >&2; exit 1; }`,
    `h() { tr -d '\\r' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64; }`,
    `echo "Checking ${disp}${layout.dir} against Task Lite install $(grep -o 'ins_[0-9A-Za-z]*' "$m" | head -n 1)"`,
    `n=0; c=0; while IFS= read -r l; do case $l in *'"key":"'*) ;; *) continue ;; esac; k=\${l#*'"key":"'}; k=\${k%%'"'*}; p=\${l#*'"path":"'}; p=\${p%%'"'*}; v=\${l#*'"version_id":"'}; v=\${v%%'"'*}; s=\${l#*'"sha256":"'}; s=\${s%%'"'*}; c=$((c+1)); f="$d/$p"`,
    `if [ ! -f "$f" ]; then st=missing; elif [ "$k" = agents_block ]; then x=$(cat "$f"; printf x); x=\${x%x}; case $x in *"$B"*"$E"*) x=\${x#*"$B"}; x=\${x%%"$E"*}; x=$(printf '%s' "$x" | tr -d '\\r'; printf x); x=\${x%x}; x=\${x#$'\\n'}; x=\${x%$'\\n'}; if [ "$(printf '%s' "$x" | h)" = "$s" ]; then st=ok; else st=edited; fi ;; *) st=missing ;; esac; elif [ "$(h < "$f")" = "$s" ]; then st=ok; else st=edited; fi`,
    `if [ $st != ok ]; then n=$((n+1)); printf '%-8s %s  (sent %s %s)\\n' "$st" "${disp}$p" "$k" "$v"; fi; done < "$m"`,
    `for x in "$d/${layout.skillsDir}"/tasklite-*/; do [ -d "$x" ] || continue; y=\${x%/}; y=\${y##*/}; grep -q "\\"skill:$y\\"" "$m" || { n=$((n+1)); printf '%-8s %s\\n' extra "${disp}${layout.skillsDir}/$y/"; }; done`,
    `if [ $n = 0 ]; then echo "Up to date: all $c files match what Task Lite sent."; else echo "Differs from what Task Lite sent: $n file(s). The install log in Agent files shows each version sent."; fi )`,
  ].join('; ');
  const powershell = [
    `& { $d = ${psBase(input)}; $m = Join-Path $d '${layout.manifest}'`,
    `if (-not (Test-Path -LiteralPath $m)) { throw "No Task Lite install found: $m is missing." }`,
    `$enc = [Text.Encoding]::GetEncoding(28591); $B = '${DOCKET_BEGIN}'; $E = '${DOCKET_END}'; $sha = [Security.Cryptography.SHA256]::Create()`,
    `function TlHash([string]$s) { -join ($sha.ComputeHash($enc.GetBytes($s.Replace("\`r", ''))) | ForEach-Object { $_.ToString('x2') }) }`,
    `$j = Get-Content -Raw -LiteralPath $m | ConvertFrom-Json; "Checking ${disp}${layout.dir} against Task Lite install $($j.install_id)"; $n = 0`,
    `foreach ($r in $j.files) { $f = Join-Path $d $r.path; $st = 'ok'; if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { $st = 'missing' } else { $x = $enc.GetString([IO.File]::ReadAllBytes($f)); if ($r.key -eq 'agents_block') { $i = $x.IndexOf($B, [StringComparison]::Ordinal); $k = $x.IndexOf($E, [StringComparison]::Ordinal); if ($i -lt 0 -or $k -lt $i) { $st = 'missing' } else { $x = $x.Substring($i + $B.Length, $k - $i - $B.Length).Replace("\`r", ''); if ($x.StartsWith("\`n")) { $x = $x.Substring(1) }; if ($x.EndsWith("\`n")) { $x = $x.Substring(0, $x.Length - 1) }; if ((TlHash $x) -ne $r.sha256) { $st = 'edited' } } } elseif ((TlHash $x) -ne $r.sha256) { $st = 'edited' } }; if ($st -ne 'ok') { $n++; '{0,-8} {1}  (sent {2} {3})' -f $st, ('${disp}' + $r.path), $r.key, $r.version_id } }`,
    `$sk = Join-Path $d '${layout.skillsDir}'; if (Test-Path -LiteralPath $sk) { foreach ($x in Get-ChildItem -LiteralPath $sk -Directory -Force -Filter 'tasklite-*') { if (@($j.files | ForEach-Object { $_.key }) -notcontains ('skill:' + $x.Name)) { $n++; '{0,-8} {1}' -f 'extra', ('${disp}${layout.skillsDir}/' + $x.Name + '/') } } }`,
    `if ($n -eq 0) { "Up to date: all $(@($j.files).Count) files match what Task Lite sent." } else { "Differs from what Task Lite sent: $n file(s). The install log in Agent files shows each version sent." } }`,
  ].join('; ');
  return { powershell, bash };
}
