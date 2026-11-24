/** Owner handoff of a live Epic producer across LLM providers. */
import { connectAgent, expect, expectAxeClean, test, useSeededContainer } from './fixtures/index';

useSeededContainer();

test('an owner releases a live Epic lead and another producer claims it without restarting the Epic', async ({
  ownerPage: page,
}) => {
  const claude = await connectAgent('claude');
  const codex = await connectAgent('codex');
  try {
    const first = await claude.call('claim_lead', {
      id: 'RCP-1',
      agent_label: 'old-producer',
      producer: 'claude-producer',
    });
    expect(first.isError, first.text).toBe(false);
    const oldRun = first.structured.run_id as string;

    await page.goto('/items/RCP-1');
    const bar = page.getByRole('region', { name: 'Lead agent' });
    await expect(bar).toContainText('claude · old-producer');
    await bar.getByRole('button', { name: 'Release lead claim…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Release lead claim on RCP-1?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog).toContainText('keep RCP-1 In progress');
    await expectAxeClean(page, 'Epic producer handoff', { include: '[role="dialog"]' });
    await dialog.getByRole('button', { name: 'Release claim' }).click();
    await expect(page.locator('.tk-head .st-progress')).toBeVisible();
    await expect(bar).toContainText('No agent on this');
    const toast = page
      .locator('.toast')
      .filter({ hasText: 'stays In progress for its next producer' });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Undo' })).toHaveCount(0);

    const late = await claude.call('heartbeat', { run_id: oldRun });
    expect(late.isError).toBe(true);
    const next = await codex.call('claim_lead', {
      id: 'RCP-1',
      agent_label: 'new-producer',
      producer: 'codex-producer',
    });
    expect(next.isError, next.text).toBe(false);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Lead agent' })).toContainText(
      'codex · new-producer',
    );
  } finally {
    await codex.close();
    await claude.close();
  }
});
