/**
 * The Jira dialog's counting words (B32): the commit button and the summary
 * name both the items and the checklist steps that sub-tasks become.
 */
import { normaliseJiraSite, type JiraReport } from '@docket/shared';
import { describe, expect, it } from 'vitest';
import { importWhat, itemCount, stepCount } from './JiraImport';

const report = (rows: [string, string, number][]): JiraReport => ({
  groups: [],
  totals: { issues: 0, would_import: 0, skipped: 0, lossy: 0 },
  mapping: rows.map(([jira, docket, count]) => ({ jira, docket, count, lossy: 0 })),
  fields: [],
  lossy_items: [],
  cycles: [],
  fields_used: [],
  attachments: { count: 0, bytes: 0, skipped: [] },
});

describe('the import button counts items and checklist steps', () => {
  it('names both, pluralised', () => {
    const r = report([
      ['Type: Story', 'Story', 300],
      ['Type: Epic', 'Epic', 28],
      ['Type: Subtask', 'Work step', 57],
      ['Type: Subtask', 'Skipped', 2],
      ['Status: Done', 'Done', 99],
    ]);
    expect(itemCount(r)).toBe(328);
    expect(stepCount(r)).toBe(57);
    expect(importWhat(r)).toBe('328 items and 57 checklist steps');
  });

  it('says one item and one checklist step', () => {
    expect(
      importWhat(
        report([
          ['Type: Task', 'Task', 1],
          ['Type: Sub-task', 'Work step', 1],
        ]),
      ),
    ).toBe('1 item and 1 checklist step');
  });

  it('leaves the steps out when there are none', () => {
    expect(importWhat(report([['Type: Bug', 'Bug', 12]]))).toBe('12 items');
  });
});

describe('the site address is normalised as the owner leaves the field', () => {
  it('adds https:// and drops paths and trailing slashes', () => {
    expect(normaliseJiraSite('acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(normaliseJiraSite('https://acme.atlassian.net/jira/software/projects/AB/boards/1')).toBe(
      'https://acme.atlassian.net',
    );
    expect(normaliseJiraSite('https://acme.atlassian.net/')).toBe('https://acme.atlassian.net');
    expect(normaliseJiraSite(' https://Acme.Atlassian.net:443/browse/AB-1 ')).toBe(
      'https://acme.atlassian.net',
    );
  });

  it('leaves what it can’t fix for the server to refuse', () => {
    expect(normaliseJiraSite('http://acme.atlassian.net/jira')).toBe(
      'http://acme.atlassian.net/jira',
    );
    expect(normaliseJiraSite('acme')).toBe('https://acme');
  });
});
