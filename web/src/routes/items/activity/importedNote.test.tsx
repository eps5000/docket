// @vitest-environment jsdom
/**
 * The Jira import's "Comments from Jira sub-tasks" notes in History
 * (decision 33; B34): the importer's layout is parsed back into sub-task
 * headings, muted author lines and comment text, and rendered so the groups
 * scan: each sub-task a level-4 heading under the History section's h3, each
 * "author · date" line muted. Any other note stays plain text.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportedNoteView } from './HistorySection';
import { IMPORTED_NOTE_PREFIX, parseImportedNote } from './importedNote';

afterEach(cleanup);

// Exactly as the importer writes it (server packSubtaskNotes), with the event's prefix.
const NOTE = `${IMPORTED_NOTE_PREFIX}Comments from Jira sub-tasks (1 of 2)

TL-7 Add Luhn check

Sam Placeholder · 2026-03-06
Done, see the unit test.

TL-8 Show inline errors

Jo Sample · 2026-03-07
Started on the card number field.

Riley Example · undated
First paragraph.

Second paragraph, same comment.`;

describe('parseImportedNote', () => {
  it('splits the note into the title, sub-task headings, author lines and text', () => {
    expect(parseImportedNote(NOTE)).toEqual({
      title: 'Comments from Jira sub-tasks (1 of 2)',
      blocks: [
        { kind: 'heading', text: 'TL-7 Add Luhn check' },
        { kind: 'by', text: 'Sam Placeholder · 2026-03-06' },
        { kind: 'text', text: 'Done, see the unit test.' },
        { kind: 'heading', text: 'TL-8 Show inline errors' },
        { kind: 'by', text: 'Jo Sample · 2026-03-07' },
        { kind: 'text', text: 'Started on the card number field.' },
        { kind: 'by', text: 'Riley Example · undated' },
        { kind: 'text', text: 'First paragraph.\n\nSecond paragraph, same comment.' },
      ],
    });
  });

  it('keeps a carried-over section’s "(continued)" heading', () => {
    const part2 = `${IMPORTED_NOTE_PREFIX}Comments from Jira sub-tasks (2 of 2)

TL-8 Show inline errors (continued)

Alex Fixture · 2026-03-09
Design pass.`;
    expect(parseImportedNote(part2)?.blocks[0]).toEqual({
      kind: 'heading',
      text: 'TL-8 Show inline errors (continued)',
    });
  });

  it('is null for every other summary, the owner’s own notes included', () => {
    expect(parseImportedNote('You left a note: TL-7 Add Luhn check')).toBeNull();
    expect(parseImportedNote(`${IMPORTED_NOTE_PREFIX}something else`)).toBeNull();
    expect(parseImportedNote('Imported comment · Sam · 2026-03-06: hi')).toBeNull();
  });
});

describe('ImportedNoteView', () => {
  it('renders each sub-task as a level-4 heading and each author line muted', () => {
    render(<ImportedNoteView note={parseImportedNote(NOTE)!} />);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'TL-7 Add Luhn check',
      'TL-8 Show inline errors',
    ]);
    const by = screen.getByText('Sam Placeholder · 2026-03-06');
    expect(by.className).toContain('src');
    expect(by.className).toContain('jn-by');
    // The comment text is ordinary body text, not muted.
    expect(screen.getByText('Done, see the unit test.').className).not.toContain('src');
    expect(screen.getByText('Comments from Jira sub-tasks (1 of 2)')).toBeTruthy();
    expect(screen.getByText('Note imported from Jira')).toBeTruthy();
  });
});
