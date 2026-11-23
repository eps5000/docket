// @vitest-environment jsdom
/**
 * The answer dialog (owner decision 47; UI_SPEC §6.3): the recommendation in
 * two actions, the keyboard, *Something else*, the note and the kept draft.
 * Undo, axe and real focus order are covered in e2e/b57-questions.spec.ts.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionForm } from '@docket/shared';
import { createAppQueryClient } from '../../app/queryClient';
import { QuestionAnswer, RecommendedLine } from './QuestionAnswer';

const form: QuestionForm = {
  context: 'The recipe card has room for one nutrition figure on a phone.',
  why_it_matters: 'People compare recipes by this number.',
  options: [
    {
      label: 'Per 100 g',
      description: 'Show the amount in a fixed weight.',
      consequences: 'Easy to compare, but people must work out their portion.',
    },
    {
      label: 'Per serving',
      description: 'Show the amount in one portion.',
      consequences: 'Easy to read, but portions differ between recipes.',
      recommended: true,
    },
  ],
  recommendation_reason: 'Most people want the amount they actually eat.',
  details: 'Follows dec_01ABC.',
};

let bodies: unknown[] = [];

beforeEach(() => {
  bodies = [];
  // user-event's radio arrow keys need CSS.escape, which jsdom doesn't have.
  vi.stubGlobal('CSS', { escape: (s: string) => s.replace(/[^\w-]/g, '\\$&') });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          mutation_id: 'mut_1',
          question: {
            id: 'q_1',
            text: 'Which?',
            asked_at: '2026-11-23T10:00:00.000Z',
            answer: 'Chose: Per serving',
            answered_at: '2026-11-23T10:01:00.000Z',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(f: QuestionForm = form) {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <QuestionAnswer
        itemId="RCP-17"
        questionId="q_1"
        question="Should recipe cards show nutrition per serving or per 100 g?"
        form={f}
        agent="codex"
        buttonLabel="Answer codex on RCP-17"
      />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Answer codex on RCP-17' }));
  return screen.getByRole('dialog');
};

describe('the answer dialog', () => {
  it('shows the background, why it matters, each option and what happens', async () => {
    const user = setup();
    const dialog = within(await open(user));
    expect(
      dialog.getByRole('heading', {
        name: 'Should recipe cards show nutrition per serving or per 100 g?',
      }),
    ).toBeTruthy();
    expect(dialog.getByText('Background')).toBeTruthy();
    expect(dialog.getByText(form.context)).toBeTruthy();
    expect(dialog.getByText('Why this matters')).toBeTruthy();
    expect(dialog.getAllByText('If you choose this:')).toHaveLength(2);
    expect(dialog.getByText(form.recommendation_reason)).toBeTruthy();
    expect(dialog.getByRole('radio', { name: /Something else/ })).toBeTruthy();
  });

  it('picks the recommendation in two actions', async () => {
    const user = setup();
    const dialog = within(await open(user));
    const recommended = dialog.getByRole<HTMLInputElement>('radio', { name: /Per serving/ });
    expect(recommended.checked).toBe(true);
    expect(document.activeElement).toBe(recommended);
    await user.click(dialog.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(bodies).toEqual([{ question_id: 'q_1', option: 'Per serving' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('moves between options with the arrow keys and sends a note', async () => {
    const user = setup();
    const dialog = within(await open(user));
    await user.keyboard('{ArrowUp}');
    const other = dialog.getByRole<HTMLInputElement>('radio', { name: /Per 100 g/ });
    expect(other.checked).toBe(true);
    await user.type(dialog.getByLabelText('Add a note (optional)'), 'Add a footnote.');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(bodies).toEqual([
        { question_id: 'q_1', option: 'Per 100 g', note: 'Add a footnote.' },
      ]),
    );
  });

  it('Something else needs text, then sends it as a free-text answer', async () => {
    const user = setup();
    const dialog = within(await open(user));
    await user.click(dialog.getByRole('radio', { name: /Something else/ }));
    expect(dialog.queryByLabelText('Add a note (optional)')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Send answer' }));
    expect(bodies).toEqual([]);
    expect(document.activeElement).toBe(dialog.getByLabelText('Your answer'));
    await user.type(dialog.getByLabelText('Your answer'), 'Show both on the detail page.');
    await user.click(dialog.getByRole('button', { name: 'Send answer' }));
    await waitFor(() =>
      expect(bodies).toEqual([{ question_id: 'q_1', text: 'Show both on the detail page.' }]),
    );
  });

  it('keeps technical details collapsed', async () => {
    const user = setup();
    const dialog = await open(user);
    const details = dialog.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(within(dialog).getByText('Technical details')).toBeTruthy();
    await user.click(within(dialog).getByText('Technical details'));
    expect(details.open).toBe(true);
  });

  it('has no details section when there are none', async () => {
    const user = setup({ ...form, details: null });
    const dialog = await open(user);
    expect(dialog.querySelector('details')).toBeNull();
  });

  it('Esc closes, focus returns to Answer, and the draft is kept', async () => {
    const user = setup();
    let dialog = within(await open(user));
    await user.type(dialog.getByLabelText('Add a note (optional)'), 'Half a thought');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    const button = screen.getByRole('button', { name: 'Answer codex on RCP-17' });
    expect(document.activeElement).toBe(button);
    dialog = within(await open(user));
    expect(dialog.getByLabelText<HTMLTextAreaElement>('Add a note (optional)').value).toBe(
      'Half a thought',
    );
  });
});

describe('RecommendedLine', () => {
  it('names the recommended option', () => {
    render(<RecommendedLine form={form} />);
    expect(screen.getByText('Recommended')).toBeTruthy();
    expect(screen.getByText(/Per serving/)).toBeTruthy();
  });
});
