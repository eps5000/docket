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
 * - **The marked section** between `<!-- docket:begin -->` and
 *   `<!-- docket:end -->`: inserted, replaced, or appended with new markers,
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
import { CONNECTION_KEY } from './connection.js';
import { CONNECTION_AWK_ITEMS, CONNECTION_PS1_ONE_LINE } from './connection-shell.js';
import type { InstallClient, InstallTargetKind } from './enums.js';
import {
  LEGACY_BEGIN,
  LEGACY_CHECK_SCRIPTS,
  LEGACY_END,
  LEGACY_MANIFEST_NAME,
  LEGACY_SKILL_PREFIX,
} from './legacy.js';

export const DOCKET_BEGIN = '<!-- docket:begin -->';
export const DOCKET_END = '<!-- docket:end -->';

/** The manifest's file name, in the client's folder (`.claude/` or `.codex/`). */
export const INSTALL_MANIFEST_NAME = '.docket-manifest.json';

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
  /** `.claude/.docket-manifest.json`. */
  manifest: string;
  /** `.claude/.tasklite-manifest.json`: an install from before the rename (B28), read when there is no new one. */
  legacyManifest: string;
  /** The old check scripts next to it, which an install leaves in place (it deletes only skill folders). */
  legacyCheckScripts: string[];
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
    legacyManifest: `${dir}/${LEGACY_MANIFEST_NAME}`,
    legacyCheckScripts: LEGACY_CHECK_SCRIPTS.map((name) => `${dir}/${name}`),
    display: target === 'repo' ? '' : '~/',
  };
}

/**
 * The installed `docket-wait` scripts (decision 40): manifest entries next to
 * the skills, so *Check* and drift cover them. They aren't agent files: they
 * have no stored versions, so an edit is restored or kept, never adopted, and
 * like the connection file an agent's `docket-check` report leaves them out.
 */
export const WAIT_SCRIPT_SH = 'docket-wait.sh';
export const WAIT_SCRIPT_PS1 = 'docket-wait.ps1';
const SCRIPT_PREFIX = 'script:';
export const WAIT_SCRIPT_KEYS = [
  `${SCRIPT_PREFIX}${WAIT_SCRIPT_SH}`,
  `${SCRIPT_PREFIX}${WAIT_SCRIPT_PS1}`,
] as const;
/**
 * The installed `docket-update` scripts (decision 56): how a project takes a new
 * Docket version in through its own workflow. Manifest entries like
 * `docket-wait`, so an install without the current one shows an update.
 */
export const UPDATE_SCRIPT_SH = 'docket-update.sh';
export const UPDATE_SCRIPT_PS1 = 'docket-update.ps1';
export const UPDATE_SCRIPT_KEYS = [
  `${SCRIPT_PREFIX}${UPDATE_SCRIPT_SH}`,
  `${SCRIPT_PREFIX}${UPDATE_SCRIPT_PS1}`,
] as const;
/** Every installed script the manifest lists. */
export const INSTALLED_SCRIPT_KEYS = [...WAIT_SCRIPT_KEYS, ...UPDATE_SCRIPT_KEYS] as const;
/** A manifest key for an installed script. */
export const isScriptKey = (key: string): boolean => key.startsWith(SCRIPT_PREFIX);
/** `docket-wait.sh`, from its manifest key. */
export const scriptNameOf = (key: string): string => key.slice(SCRIPT_PREFIX.length);

/** The path a file is installed at, relative to the base: `.claude/skills/docket-worker/SKILL.md`. */
export function installPathOf(layout: InstallLayout, key: string): string {
  if (key.startsWith('skill:')) return `${layout.skillsDir}/${key.slice('skill:'.length)}/SKILL.md`;
  if (isScriptKey(key)) return `${layout.dir}/${scriptNameOf(key)}`;
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
  /**
   * `start` is the begin marker's index; `end` is just after the end marker.
   * `legacy`: the markers are the old `<!-- tasklite:begin/end -->` pair (B28),
   * a valid section that the next install replaces with the `docket` markers.
   */
  | { kind: 'present'; start: number; end: number; inner: string; legacy: boolean };

function findPair(text: string, begin: string, end: string, legacy: boolean): MarkedSection {
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b < 0 && e < 0) return { kind: 'absent' };
  if (b < 0 || e < b) return { kind: 'broken' };
  if (text.indexOf(begin, b + 1) >= 0 || text.indexOf(end, e + 1) >= 0) {
    return { kind: 'broken' };
  }
  return {
    kind: 'present',
    start: b,
    end: e + end.length,
    inner: text.slice(b + begin.length, e),
    legacy,
  };
}

/**
 * Find the Docket section in a file's text: the `docket` markers, or else the
 * old `tasklite` pair (B28). Both kinds in one file is ambiguous, so broken.
 */
export function findMarkedSection(text: string): MarkedSection {
  const current = findPair(text, DOCKET_BEGIN, DOCKET_END, false);
  const legacy = findPair(text, LEGACY_BEGIN, LEGACY_END, true);
  if (current.kind === 'absent') return legacy;
  if (legacy.kind !== 'absent') return { kind: 'broken' };
  return current;
}

export class BrokenMarkersError extends Error {
  constructor(file: string) {
    super(
      `${file} has a damaged Docket section: a ${DOCKET_BEGIN} or ${DOCKET_END} line is missing or repeated. Fix the markers, then install again.`,
    );
    this.name = 'BrokenMarkersError';
  }
}

/**
 * The line a new CLAUDE.md starts with when the repo already has AGENTS.md
 * (decision 34): Claude Code imports the project's own rules from it. It sits
 * outside the Docket markers, so the check and drift never compare it, and it
 * is never added to a CLAUDE.md that already exists.
 */
export const IMPORT_AGENTS_LINE = '@AGENTS.md';

/** Whether an install writes the import: Claude Code into a repo (CLAUDE.md next to AGENTS.md). */
export const importsAgentsMd = (client: InstallClient, target: InstallTargetKind): boolean =>
  client === 'claude' && target === 'repo';

/**
 * The files that show a repo is set up for each client (decision 34): the
 * Install dialog ticks the clients whose markers it finds, or both when none.
 * Folders end in `/`.
 */
export const CLIENT_MARKERS: Record<InstallClient, readonly string[]> = {
  claude: ['.claude/', 'CLAUDE.md'],
  codex: ['.codex/', '.agents/', 'AGENTS.md'],
};

/** The section as written: the markers on their own lines around the block. */
export const markedSection = (block: string): string => `${DOCKET_BEGIN}\n${block}\n${DOCKET_END}`;

/**
 * Insert or replace the Docket section in `existing` (null: no file yet).
 * Everything before the begin marker and after the end marker stays exactly
 * as it was. Without markers the section is appended after a blank line, so
 * the old text is an exact prefix of the new. Throws `BrokenMarkersError`.
 */
export function mergeMarkedSection(
  existing: string | null,
  block: string,
  file = 'The instructions file',
  /** A new file starts with `@AGENTS.md` and a blank line (decision 34): only when creating it. */
  opts: { importAgents?: boolean } = {},
): { text: string; how: 'created' | 'replaced' | 'appended'; legacy?: true; imported?: true } {
  const section = markedSection(block);
  if (existing === null) {
    return opts.importAgents
      ? { text: `${IMPORT_AGENTS_LINE}\n\n${section}\n`, how: 'created', imported: true }
      : { text: `${section}\n`, how: 'created' };
  }
  const found = findMarkedSection(existing);
  if (found.kind === 'broken') throw new BrokenMarkersError(file);
  if (found.kind === 'present') {
    // An old `tasklite` section is replaced the same way, with the new markers.
    return {
      text: existing.slice(0, found.start) + section + existing.slice(found.end),
      how: 'replaced',
      ...(found.legacy ? { legacy: true as const } : {}),
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
  'Docket refused the download: this command was already used or is more than 10 minutes old. Make a new one in Agent files.';

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
    `bash "$t/docket-install/install.sh" "$d" )`,
  ].join('; ');
  const powershell = [
    `& { $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $d = ${psBase(input)}`,
    ...(repo
      ? [
          `if (-not (Test-Path -LiteralPath (Join-Path $d '.git'))) { throw "Run this from the repo folder: there is no .git in $d" }`,
        ]
      : []),
    `$t = Join-Path ([IO.Path]::GetTempPath()) ('docket-' + [guid]::NewGuid()); New-Item -ItemType Directory -Path $t | Out-Null`,
    `try { $b = Join-Path $t 'b.tgz'; try { Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(input.url)} -OutFile $b } catch { throw ${psQuote(REFUSED)} }`,
    // Windows' own tar.exe: a GNU tar from Git on the PATH would read `C:` as a remote host.
    `$x = 'tar'; if ($env:SystemRoot) { $w = Join-Path $env:SystemRoot 'System32/tar.exe'; if (Test-Path -LiteralPath $w) { $x = $w } }; & $x -xzf $b -C $t; if ($LASTEXITCODE) { throw 'Could not unpack the download.' }`,
    `$i = Join-Path (Join-Path $t 'docket-install') 'install.ps1'; & ([scriptblock]::Create((Get-Content -Raw -LiteralPath $i))) (Join-Path $t 'docket-install') $d } finally { Remove-Item -Recurse -Force -LiteralPath $t } }`,
  ].join('; ');
  return { powershell, bash };
}

const REFUSED_UNINSTALL =
  'Docket refused the download: this uninstall command was already used or is more than 10 minutes old. Make a new one in Agent files.';

/**
 * The uninstall one-liners (decision 50): the same flow as install. Download
 * the single-use bundle, unpack it into a temporary folder, run its step on
 * the install's folder, and remove the temporary folder. The step reports what
 * it did to `<url>/report`. A repo uninstall refuses a folder without `.git`
 * before the download uses the token.
 */
export function uninstallCommands(input: InstallCommandInput & { url: string }): {
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
    `curl -fsS --noproxy '*' -o "$t/b.tgz" ${bashQuote(input.url)} || { echo ${bashQuote(REFUSED_UNINSTALL)} >&2; exit 1; }`,
    `tar -xzf "$t/b.tgz" -C "$t"`,
    `bash "$t/docket-uninstall/uninstall.sh" "$d" ${bashQuote(input.url)} )`,
  ].join('; ');
  const powershell = [
    `& { $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $d = ${psBase(input)}`,
    ...(repo
      ? [
          `if (-not (Test-Path -LiteralPath (Join-Path $d '.git'))) { throw "Run this from the repo folder: there is no .git in $d" }`,
        ]
      : []),
    `$t = Join-Path ([IO.Path]::GetTempPath()) ('docket-' + [guid]::NewGuid()); New-Item -ItemType Directory -Path $t | Out-Null`,
    `try { $b = Join-Path $t 'b.tgz'; try { Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(input.url)} -OutFile $b } catch { throw ${psQuote(REFUSED_UNINSTALL)} }`,
    // Windows' own tar.exe: a GNU tar from Git on the PATH would read `C:` as a remote host.
    `$x = 'tar'; if ($env:SystemRoot) { $w = Join-Path $env:SystemRoot 'System32/tar.exe'; if (Test-Path -LiteralPath $w) { $x = $w } }; & $x -xzf $b -C $t; if ($LASTEXITCODE) { throw 'Could not unpack the download.' }`,
    `$i = Join-Path (Join-Path $t 'docket-uninstall') 'uninstall.ps1'; & ([scriptblock]::Create((Get-Content -Raw -LiteralPath $i))) $d ${psQuote(input.url)} } finally { Remove-Item -Recurse -Force -LiteralPath $t } }`,
  ].join('; ');
  return { powershell, bash };
}

/**
 * The check one-liners (FR-127, without push): read the manifest the install
 * left, hash each file as the check defines it, and print the files that
 * were edited locally, are missing, or are extra `docket-*` skill folders,
 * each with the version Docket sent. They download nothing and need no
 * token. Run them where the install ran (the repo folder, for a repo).
 */
export function checkCommands(input: InstallCommandInput): { powershell: string; bash: string } {
  const layout = installLayout(input.client, input.target_kind);
  const disp = layout.display;
  const bash = [
    `( d=${bashBase(input)}; m="$d/${layout.manifest}"; [ -f "$m" ] || { [ -f "$d/${layout.legacyManifest}" ] && m="$d/${layout.legacyManifest}"; }; B='${DOCKET_BEGIN}'; E='${DOCKET_END}'; OB='${LEGACY_BEGIN}'; OE='${LEGACY_END}'`,
    `[ -f "$m" ] || { echo "No Docket install found: $m is missing." >&2; exit 1; }`,
    `h() { tr -d '\\r' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64; }`,
    // The connection file's scanner (decision 32): only its docket entry is compared.
    ...(input.target_kind === 'repo'
      ? [`A=$(printf '%s\\n' ${CONNECTION_AWK_ITEMS.map((i) => `'${i}'`).join(' ')})`]
      : []),
    `echo "Checking ${disp}${layout.dir} against Docket install $(grep -o 'ins_[0-9A-Za-z]*' "$m" | head -n 1)"`,
    `n=0; c=0; while IFS= read -r l; do case $l in *'"key":"'*) ;; *) continue ;; esac; k=\${l#*'"key":"'}; k=\${k%%'"'*}; p=\${l#*'"path":"'}; p=\${p%%'"'*}; v=\${l#*'"version_id":"'}; v=\${v%%'"'*}; s=\${l#*'"sha256":"'}; s=\${s%%'"'*}; c=$((c+1)); f="$d/$p"`,
    `if [ ! -f "$f" ]; then st=missing; elif [ "$k" = ${CONNECTION_KEY} ]; then x=$(LC_ALL=C awk -v mode=${input.client === 'codex' ? 'toml' : 'json'} -v out=canon "$A" "$f"); case $x in '!invalid') st=edited ;; '!absent') st=missing ;; *) if [ "$(printf '%s' "$x" | h)" = "$s" ]; then st=ok; else st=edited; fi ;; esac; elif [ "$k" = agents_block ]; then x=$(cat "$f"; printf x); x=\${x%x}; case $x in *"$B"*) ;; *) B=$OB; E=$OE ;; esac; case $x in *"$B"*"$E"*) x=\${x#*"$B"}; x=\${x%%"$E"*}; x=$(printf '%s' "$x" | tr -d '\\r'; printf x); x=\${x%x}; x=\${x#$'\\n'}; x=\${x%$'\\n'}; if [ "$(printf '%s' "$x" | h)" = "$s" ]; then st=ok; else st=edited; fi ;; *) st=missing ;; esac; elif [ "$(h < "$f")" = "$s" ]; then st=ok; else st=edited; fi`,
    `if [ $st != ok ]; then n=$((n+1)); printf '%-8s %s  (sent %s %s)\\n' "$st" "${disp}$p" "$k" "$v"; fi; done < "$m"`,
    `for x in "$d/${layout.skillsDir}"/docket-*/ "$d/${layout.skillsDir}"/${LEGACY_SKILL_PREFIX}*/; do [ -d "$x" ] || continue; y=\${x%/}; y=\${y##*/}; o=''; case $y in ${LEGACY_SKILL_PREFIX}*) o='  (old name)' ;; esac; grep -q "\\"skill:$y\\"" "$m" || { n=$((n+1)); printf '%-8s %s%s\\n' extra "${disp}${layout.skillsDir}/$y/" "$o"; }; done`,
    `if [ $n = 0 ]; then echo "Up to date: all $c files match what Docket sent."; else echo "Differs from what Docket sent: $n file(s). The install log in Agent files shows each version sent."; fi )`,
  ].join('; ');
  const powershell = [
    `& { $d = ${psBase(input)}; $m = Join-Path $d '${layout.manifest}'; if (-not (Test-Path -LiteralPath $m)) { $o = Join-Path $d '${layout.legacyManifest}'; if (Test-Path -LiteralPath $o) { $m = $o } }`,
    `if (-not (Test-Path -LiteralPath $m)) { throw "No Docket install found: $m is missing." }`,
    `$enc = [Text.Encoding]::GetEncoding(28591); $B = '${DOCKET_BEGIN}'; $E = '${DOCKET_END}'; $OB = '${LEGACY_BEGIN}'; $OE = '${LEGACY_END}'; $sha = [Security.Cryptography.SHA256]::Create()`,
    `function TlHash([string]$s) { -join ($sha.ComputeHash($enc.GetBytes($s.Replace("\`r", ''))) | ForEach-Object { $_.ToString('x2') }) }`,
    // The connection file's scanner (decision 32): only its docket entry is compared.
    ...(input.target_kind === 'repo' ? [CONNECTION_PS1_ONE_LINE] : []),
    `$j = Get-Content -Raw -LiteralPath $m | ConvertFrom-Json; "Checking ${disp}${layout.dir} against Docket install $($j.install_id)"; $n = 0`,
    `foreach ($r in $j.files) { $f = Join-Path $d $r.path; $st = 'ok'; if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { $st = 'missing' } else { $x = $enc.GetString([IO.File]::ReadAllBytes($f)); if ($r.key -eq '${CONNECTION_KEY}') { $x = DkCanon '${input.client}' $x; if ($x -ceq '!invalid') { $st = 'edited' } elseif ($null -eq $x) { $st = 'missing' } elseif ((TlHash $x) -ne $r.sha256) { $st = 'edited' } } elseif ($r.key -eq 'agents_block') { if ($x.IndexOf($B, [StringComparison]::Ordinal) -lt 0) { $B = $OB; $E = $OE }; $i = $x.IndexOf($B, [StringComparison]::Ordinal); $k = $x.IndexOf($E, [StringComparison]::Ordinal); if ($i -lt 0 -or $k -lt $i) { $st = 'missing' } else { $x = $x.Substring($i + $B.Length, $k - $i - $B.Length).Replace("\`r", ''); if ($x.StartsWith("\`n")) { $x = $x.Substring(1) }; if ($x.EndsWith("\`n")) { $x = $x.Substring(0, $x.Length - 1) }; if ((TlHash $x) -ne $r.sha256) { $st = 'edited' } } } elseif ((TlHash $x) -ne $r.sha256) { $st = 'edited' } }; if ($st -ne 'ok') { $n++; '{0,-8} {1}  (sent {2} {3})' -f $st, ('${disp}' + $r.path), $r.key, $r.version_id } }`,
    `$sk = Join-Path $d '${layout.skillsDir}'; if (Test-Path -LiteralPath $sk) { foreach ($x in @(Get-ChildItem -LiteralPath $sk -Directory -Force -Filter 'docket-*') + @(Get-ChildItem -LiteralPath $sk -Directory -Force -Filter '${LEGACY_SKILL_PREFIX}*')) { if (@($j.files | ForEach-Object { $_.key }) -notcontains ('skill:' + $x.Name)) { $n++; $o = ''; if ($x.Name.StartsWith('${LEGACY_SKILL_PREFIX}')) { $o = '  (old name)' }; '{0,-8} {1}{2}' -f 'extra', ('${disp}${layout.skillsDir}/' + $x.Name + '/'), $o } } }`,
    `if ($n -eq 0) { "Up to date: all $(@($j.files).Count) files match what Docket sent." } else { "Differs from what Docket sent: $n file(s). The install log in Agent files shows each version sent." } }`,
  ].join('; ');
  return { powershell, bash };
}

// ---- Taking an update (decision 56) ----

/**
 * The one-liners that fetch the current `docket-update` from this Docket and
 * run it in the current checkout, for an install that doesn't have it yet. In
 * protected mode they send `DOCKET_TOKEN` from the environment, on stdin in
 * bash so it never shows in a process list. Nothing is written to the repo
 * but the agent files, and nothing is committed.
 */
export function updateCommands(
  baseUrl: string,
  protectedMode: boolean,
): { powershell: string; bash: string } {
  const base = baseUrl.replace(/\/+$/, '');
  const sh = bashQuote(`${base}/agent/update/${UPDATE_SCRIPT_SH}`);
  const ps = psQuote(`${base}/agent/update/${UPDATE_SCRIPT_PS1}`);
  const fetch = protectedMode
    ? `: "\${DOCKET_TOKEN:?Set DOCKET_TOKEN first}"; printf 'Authorization: Bearer %s\\n' "$DOCKET_TOKEN" | curl -fsS --noproxy '*' -H @- -o "$t" ${sh}`
    : `curl -fsS --noproxy '*' -o "$t" ${sh}`;
  const headers = protectedMode ? ` -Headers @{Authorization="Bearer $env:DOCKET_TOKEN"}` : '';
  return {
    bash: `( t=$(mktemp); trap 'rm -f "$t"' EXIT; ${fetch} && bash "$t" --url ${bashQuote(base)} )`,
    powershell: `& ([scriptblock]::Create((Invoke-RestMethod -UseBasicParsing -ErrorAction Stop${headers} ${ps}))) --url ${psQuote(base)}`,
  };
}

/**
 * The one notice an agent reads when its project's installed files are behind
 * (decision 56): who acts, and the exact command.
 */
export function updateNotice(
  count: number,
  commands: { powershell: string; bash: string },
): string {
  const files = count === 1 ? '1 file' : `${count} files`;
  return `Docket has an update for this repo's agent files (${files}). Coordinator: unless a PR for it is open, take it first as one small PR on its own branch: ${commands.bash} (PowerShell: ${commands.powershell}). Workers: tell your coordinator; don't update files yourself.`;
}
