/**
 * The Jira import's "Comments from Jira sub-tasks" notes (decision 33;
 * BUILD_SPEC §9), as History shows them. The note is plain text, so agents
 * read it as is; its layout is fixed by the importer (server
 * `packSubtaskNotes`):
 *
 * ```text
 * Comments from Jira sub-tasks (1 of 2)
 *
 * TL-7 Add Luhn check
 *
 * Sam Placeholder · 2026-03-06
 * Done, see the unit test.
 * ```
 *
 * A sub-task heading is a line between blank lines, followed by an author
 * line; an author line is `name · YYYY-MM-DD` (or `· undated`) after a blank
 * line, with the comment's text on the next lines. History renders headings
 * as headings and author lines muted, so the groups scan.
 */

/** The History summary of an imported note (`owner_note.added`). */
export const IMPORTED_NOTE_PREFIX = 'Note imported from Jira: ';
const TITLE = 'Comments from Jira sub-tasks';
const AUTHOR = /^\S.* · (\d{4}-\d{2}-\d{2}|undated)$/;

export type NoteBlock =
  { kind: 'heading'; text: string } | { kind: 'by'; text: string } | { kind: 'text'; text: string };

export interface ImportedNote {
  /** "Comments from Jira sub-tasks (1 of 2)". */
  title: string;
  blocks: NoteBlock[];
}

/** The note's parts, or null when the summary isn't an imported sub-task note. */
export function parseImportedNote(summary: string): ImportedNote | null {
  if (!summary.startsWith(IMPORTED_NOTE_PREFIX)) return null;
  const lines = summary.slice(IMPORTED_NOTE_PREFIX.length).split('\n');
  const title = lines[0] ?? '';
  if (!title.startsWith(TITLE)) return null;
  const blocks: NoteBlock[] = [];
  let text: string[] = [];
  const flush = () => {
    const t = text.join('\n').trim();
    if (t) blocks.push({ kind: 'text', text: t });
    text = [];
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const afterBlank = lines[i - 1] === '';
    if (afterBlank && line !== '' && lines[i + 1] === '' && AUTHOR.test(lines[i + 2] ?? '')) {
      flush();
      blocks.push({ kind: 'heading', text: line });
      i++; // The blank line after it.
      continue;
    }
    if (afterBlank && AUTHOR.test(line) && (lines[i + 1] ?? '') !== '') {
      flush();
      blocks.push({ kind: 'by', text: line });
      continue;
    }
    text.push(line);
  }
  flush();
  return { title, blocks };
}
