// @vitest-environment jsdom
/**
 * Approve with notes on the packet screen (owner decision 35; UI_SPEC §6.4;
 * tasks.md T180): *Looks good* reveals "Notes for later (optional)", a note
 * reveals "Keep it for", all reachable by keyboard; without an epic the
 * epic choice is disabled and says why; a past round shows the note and
 * links the decision. Axe runs in the e2e (b37-approve-notes.spec.ts).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewResponse } from '@docket/shared';
import { EMPTY_DRAFT, type Draft } from './decision';
import { LiveItem, PastItem, type KeepScope } from './PacketScreen';

type PacketItem = ReviewResponse['packet']['items'][number];

afterEach(cleanup);

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const ITEM: PacketItem = {
  hr_item_id: 'hr_a',
  text: 'Reload the planner on week 3. Does it stay on week 3?',
  state: 'ready',
  decision: null,
};

const NOTE = 'Fine here, but next time put the fixture in tests/fixtures/';

/** The draft as of the last change (written from the event handler, not during render). */
let last: Draft = EMPTY_DRAFT;

function Live({ scope }: { scope: KeepScope }) {
  const [draft, set] = useState<Draft>(EMPTY_DRAFT);
  return (
    <LiveItem
      n={0}
      item={ITEM}
      draft={draft}
      noteMissing={false}
      setDraft={(patch) => {
        last = { ...last, ...patch };
        set(last);
      }}
      scope={scope}
    />
  );
}

const WITH_EPIC: KeepScope = { item: 'GF-312', epic: 'GF-300', project: 'Gameflow' };

describe('Looks good with notes for later', () => {
  beforeEach(() => {
    last = EMPTY_DRAFT;
  });
  it('reveals the note, then Keep it for, all by keyboard', async () => {
    const user = userEvent.setup();
    wrap(<Live scope={WITH_EPIC} />);
    expect(screen.queryByLabelText('Notes for later (optional)')).toBeNull();

    const good = screen.getByRole('radio', { name: 'Looks good' });
    good.focus();
    await user.keyboard(' ');
    expect(good.getAttribute('aria-checked')).toBe('true');
    const note = screen.getByLabelText('Notes for later (optional)');
    expect(note.getAttribute('placeholder')).toBe(
      'e.g. Fine here, but next time put the fixture in tests/fixtures/',
    );
    // No Keep it for until the note has text.
    expect(screen.queryByRole('group', { name: 'Keep the note on item 1 for' })).toBeNull();

    await user.tab();
    expect(document.activeElement).toBe(note);
    await user.keyboard(NOTE);
    const group = screen.getByRole('group', { name: 'Keep the note on item 1 for' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'This ticket',
      'The epic’s future tickets',
      'All Gameflow work',
    ]);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Posted as a note for the agent on GF-312.')).toBeTruthy();

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(buttons[1]);
    await user.keyboard(' ');
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(last).toMatchObject({ kind: 'approve', note: NOTE, keep: 'epic' });
    expect(
      screen.getByText(
        'Also saved as an owner decision on GF-300: agents get it on the epic’s other tickets.',
      ),
    ).toBeTruthy();

    await user.tab();
    expect(document.activeElement).toBe(buttons[2]);
    await user.keyboard('{Enter}');
    expect(last.keep).toBe('project');
    expect(
      screen.getByText(
        'Also saved as an owner decision for Gameflow: every agent working on it gets it.',
      ),
    ).toBeTruthy();

    // Clearing the note hides Keep it for again.
    await user.clear(note);
    expect(screen.queryByRole('group', { name: 'Keep the note on item 1 for' })).toBeNull();
  });

  it('without an epic, the epic choice is disabled, says why, and is skipped by Tab', async () => {
    const user = userEvent.setup();
    wrap(<Live scope={{ item: 'GF-9', epic: null, project: 'Gameflow' }} />);
    await user.click(screen.getByRole('radio', { name: 'Looks good' }));
    await user.type(screen.getByLabelText('Notes for later (optional)'), 'Keep it short.');
    const epic = screen.getByRole('button', { name: 'The epic’s future tickets' });
    expect((epic as HTMLButtonElement).disabled).toBe(true);
    const why = document.getElementById(epic.getAttribute('aria-describedby')!);
    expect(why?.textContent).toBe('GF-9 has no epic, so the note can’t go to an epic’s tickets.');
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'All Gameflow work' }));
  });
});

describe('a past round', () => {
  it('shows the note on an approved finding and links the decision it became', () => {
    wrap(
      <PastItem
        n={0}
        itemId="GF-312"
        item={{
          ...ITEM,
          state: 'approved',
          decision: {
            kind: 'approve',
            note: NOTE,
            into: null,
            follow: null,
            keep: 'epic',
            decision_id: 'dec_01',
            result_ref: '→ decision for the epic’s future tickets',
            decided_at: '2026-11-19T10:00:00Z',
          },
        }}
      />,
    );
    expect(screen.getByText(`“${NOTE}”`, { exact: false }).textContent).toBe(
      `Note for later: “${NOTE}”`,
    );
    const link = screen.getByRole('link', { name: '→ decision for the epic’s future tickets' });
    expect(link.getAttribute('href')).toBe('/items/GF-312?tab=details');
  });
});
