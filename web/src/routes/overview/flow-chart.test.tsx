// @vitest-environment jsdom
/**
 * Flow trends (owner decision 48): the summary and merged wording, the tooltip
 * by mouse and keyboard, and the text alternative.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { OverviewResponse } from '@docket/shared';
import { FlowChart, bucketText, flowSummary, mergedNote } from './FlowChart';

type Flow = OverviewResponse['flow'];

const flow = (over: Partial<Flow> = {}): Flow => ({
  granularity: 'day',
  buckets: [
    { key: '2026-11-20', label: 'Nov 20', finished: 8, merged: 7, parked: 15 },
    { key: '2026-11-21', label: 'Nov 21', finished: 5, merged: 8, parked: 45 },
    { key: '2026-11-22', label: 'Nov 22', finished: 0, merged: 0, parked: 0 },
  ],
  finished: 13,
  merged: 15,
  parked: 60,
  finished_without_merge: 0,
  note: null,
  ...over,
});

afterEach(cleanup);

describe('the words', () => {
  it('sums the window, with singular forms', () => {
    expect(flowSummary(flow())).toBe('13 tickets finished, 15 PRs merged, parked 60 times.');
    expect(flowSummary(flow({ finished: 1, merged: 1, parked: 1 }))).toBe(
      '1 ticket finished, 1 PR merged, parked 1 time.',
    );
  });

  it('says so when the window is empty', () => {
    expect(flowSummary(flow({ finished: 0, merged: 0, parked: 0 }))).toBe(
      'Nothing finished, merged or parked in this window.',
    );
  });

  it('always says merged is only what was recorded, and says when it is partial', () => {
    expect(mergedNote(flow())).toBe('Merged counts only PRs an agent recorded in Docket.');
    expect(mergedNote(flow({ finished_without_merge: 4 }))).toBe(
      'Merged counts only PRs an agent recorded in Docket. 4 of 13 finished tickets have none recorded, so the real number may be higher.',
    );
    expect(mergedNote(flow({ finished: 1, finished_without_merge: 1 }))).toContain(
      '1 of 1 finished ticket has none recorded',
    );
  });
});

describe('the chart', () => {
  const tipOf = () => document.querySelector<HTMLElement>('[data-flow-tip]');

  it('shows the divergence note only when there is one', () => {
    const { rerender } = render(<FlowChart flow={flow()} />);
    expect(document.querySelector('[data-flow-note]')).toBeNull();
    const note = 'Parking is up while finished tickets are down.';
    rerender(<FlowChart flow={flow({ note })} />);
    expect(document.querySelector('[data-flow-note]')?.textContent).toBe(note);
  });

  it('opens one tooltip with all three values on hover', async () => {
    const user = userEvent.setup();
    render(<FlowChart flow={flow()} />);
    await user.hover(screen.getByRole('button', { name: bucketText(flow().buckets[1]!) }));
    const tip = tipOf()!;
    expect(tip.dataset.flowTip).toBe('2026-11-21');
    expect(within(tip).getByText('Finished').nextSibling?.textContent).toBe('5');
    expect(within(tip).getByText('Merged').nextSibling?.textContent).toBe('8');
    expect(within(tip).getByText('Parked').nextSibling?.textContent).toBe('45');
  });

  it('is one tab stop, moves with the arrow keys, and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<FlowChart flow={flow()} />);
    const stops = screen.getAllByRole('button').filter((b) => b.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    // The newest slot with something in it.
    expect(stops[0]!.dataset.flowBar).toBe('2026-11-21');

    await user.tab();
    expect(tipOf()?.dataset.flowTip).toBe('2026-11-21');
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(document.querySelector('[data-flow-bar="2026-11-20"]'));
    expect(tipOf()?.dataset.flowTip).toBe('2026-11-20');
    await user.keyboard('{Escape}');
    expect(tipOf()).toBeNull();
  });

  it('has a table with the same values', () => {
    render(<FlowChart flow={flow()} />);
    const table = screen.getByRole('table', {
      name: 'Tickets finished, PRs merged and times parked per day',
    });
    const row = within(table).getByRole('row', { name: /Nov 21/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['5', '8', '45']);
  });

  it('labels hours in the 24-hour window', () => {
    render(
      <FlowChart
        flow={flow({
          granularity: 'hour',
          buckets: [{ key: 'a', label: '10:00', finished: 1, merged: 0, parked: 2 }],
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Flow per hour' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Hour' })).toBeTruthy();
  });
});
