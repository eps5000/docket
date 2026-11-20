import { describe, expect, it } from 'vitest';
import type { AgentFileDetail, AgentFileRow, PushTargetResponse } from '@docket/shared';
import {
  INSTALL_STATE_VIEW,
  installButtonLabel,
  copyOutdated,
  defaultAt,
  defaultOf,
  insidePushFolder,
  rowCopyOutdated,
  versionLabel,
  versionsOf,
} from './model';
import { WORKFLOW_STARTER } from './WorkflowNotes';

const v = (id: string, version_no: number, created_at: string, content = id) => ({
  id,
  version_no,
  sha256: `sha-${id}`,
  author: 'owner',
  note: null,
  created_at,
  content,
});

function detail(
  over: Partial<AgentFileDetail['layers']>,
  flag: AgentFileDetail['bundled_updated'] = null,
): AgentFileDetail {
  return {
    key: 'skill:docket-worker',
    kind: 'skill',
    name: 'docket-worker',
    project: 'RCP',
    effective_layer: over.project ? 'project' : over.service ? 'service' : 'bundled',
    layers: {
      bundled: {
        file_id: 'b',
        current_version_no: 1,
        versions: [v('b1', 1, '2026-11-01T00:00:00Z')],
      },
      service: null,
      project: null,
      ...over,
    },
    bundled_updated: flag,
  };
}

describe('Agent files model (B25)', () => {
  it('names versions without the words bundled, layer, override or service-wide', () => {
    expect(versionLabel({ layer: 'bundled', version_no: 2 }, 'Recipe App')).toBe(
      'Docket’s version v2',
    );
    expect(versionLabel({ layer: 'service', version_no: 1 }, 'Recipe App')).toBe(
      'Edited default v1',
    );
    expect(versionLabel({ layer: 'project', version_no: 3 }, 'Recipe App')).toBe(
      'Recipe App’s copy v3',
    );
  });

  it('the default is the edit when there is one, else Docket’s version', () => {
    expect(defaultOf(versionsOf(detail({})))?.id).toBe('b1');
    const edited = detail({
      service: {
        file_id: 's',
        current_version_no: 1,
        versions: [v('s1', 1, '2026-11-02T00:00:00Z')],
      },
    });
    expect(defaultOf(versionsOf(edited))?.id).toBe('s1');
    // A reset edit (no current version) leaves Docket's version as the default.
    const reset = detail({
      service: {
        file_id: 's',
        current_version_no: 0,
        versions: [v('s1', 1, '2026-11-02T00:00:00Z')],
      },
    });
    expect(defaultOf(versionsOf(reset))?.id).toBe('b1');
  });

  it('flags a copy when the default was edited after it, and compares the default then and now', () => {
    const d = detail({
      service: {
        file_id: 's',
        current_version_no: 1,
        versions: [v('s1', 1, '2026-11-05T00:00:00Z')],
      },
      project: {
        file_id: 'p',
        current_version_no: 1,
        versions: [v('p1', 1, '2026-11-03T00:00:00Z')],
      },
    });
    const versions = versionsOf(d);
    expect(defaultAt(versions, '2026-11-03T00:00:00Z')?.id).toBe('b1');
    const o = copyOutdated(d, versions);
    expect(o?.from?.id).toBe('b1');
    expect(o?.to?.id).toBe('s1');
  });

  it('flags a copy when Docket shipped a new version since it (the server flag)', () => {
    const d = detail(
      {
        bundled: {
          file_id: 'b',
          current_version_no: 2,
          versions: [v('b2', 2, '2026-11-06T00:00:00Z'), v('b1', 1, '2026-11-01T00:00:00Z')],
        },
        project: {
          file_id: 'p',
          current_version_no: 1,
          versions: [v('p1', 1, '2026-11-03T00:00:00Z')],
        },
      },
      { edited_layer: 'project', from_version_id: 'b1', to_version_id: 'b2' },
    );
    const o = copyOutdated(d, versionsOf(d));
    expect([o?.from?.id, o?.to?.id]).toEqual(['b1', 'b2']);
  });

  it('doesn’t flag a copy made after the default’s last edit, or a project using the default', () => {
    const d = detail({
      service: {
        file_id: 's',
        current_version_no: 1,
        versions: [v('s1', 1, '2026-11-02T00:00:00Z')],
      },
      project: {
        file_id: 'p',
        current_version_no: 1,
        versions: [v('p1', 1, '2026-11-03T00:00:00Z')],
      },
    });
    expect(copyOutdated(d, versionsOf(d))).toBeNull();
    expect(copyOutdated(detail({}), versionsOf(detail({})))).toBeNull();
  });

  it('flags a list row the same way', () => {
    const ref = (at: string) => ({
      id: at,
      version_no: 1,
      sha256: '',
      author: 'owner',
      note: null,
      created_at: at,
    });
    const row = (service: string | null, project: string | null, flag = false): AgentFileRow => ({
      key: 'skill:x',
      kind: 'skill',
      name: 'x',
      effective_layer: project ? 'project' : service ? 'service' : 'bundled',
      effective: ref(project ?? service ?? '2026-11-01'),
      layers: {
        bundled: ref('2026-11-01'),
        service: service ? ref(service) : null,
        project: project ? ref(project) : null,
      },
      bundled_updated: flag,
    });
    expect(rowCopyOutdated(row('2026-11-05', '2026-11-03'))).toBe(true);
    expect(rowCopyOutdated(row('2026-11-02', '2026-11-03'))).toBe(false);
    expect(rowCopyOutdated(row(null, '2026-11-03', true))).toBe(true);
    expect(rowCopyOutdated(row('2026-11-05', null))).toBe(false);
  });

  it('picks push only for folders inside the push folder', () => {
    const t: PushTargetResponse = {
      configured: true,
      writable: true,
      container_path: '/host-code',
      host_path: 'C:/Users/owner/code',
    };
    expect(insidePushFolder('C:/Users/owner/code/recipes', t)).toBe(true);
    expect(insidePushFolder('c:\\users\\owner\\code\\recipes\\', t)).toBe(true);
    expect(insidePushFolder('/host-code/recipes', t)).toBe(true);
    expect(insidePushFolder('recipes', t)).toBe(true);
    expect(insidePushFolder('C:/Users/owner/code-evil/x', t)).toBe(false);
    expect(insidePushFolder('D:/code/recipes', t)).toBe(false);
    expect(insidePushFolder('~/code/recipes', t)).toBe(false);
    expect(insidePushFolder('../outside', t)).toBe(false);
    expect(insidePushFolder('', t)).toBe(false);
    expect(insidePushFolder('recipes', { ...t, configured: false })).toBe(false);
  });
});

describe('the Workflow notes starter', () => {
  it('is bundled, has every topic, and has suggested answers, not placeholders', () => {
    for (const heading of [
      '## Moving work to Ready',
      '## Planning documents',
      '## Human review',
      '## Blockers',
      '## Branches and commits',
      '## Checks to run',
      '## Decisions worth recording',
      '## Labels',
    ]) {
      expect(WORKFLOW_STARTER).toContain(heading);
    }
    expect(WORKFLOW_STARTER).toContain('Only the owner moves items to Ready.');
    expect(WORKFLOW_STARTER).not.toContain('{{');
    expect(WORKFLOW_STARTER.length).toBeLessThan(10_000);
  });
});

describe('install state (decision 34)', () => {
  it('labels each state, and never offers a plain Install for an installed client', () => {
    expect(INSTALL_STATE_VIEW.update_available.label).toBe('Installed · update available');
    expect(installButtonLabel(['not_installed', 'not_installed'])).toBe('Install');
    expect(installButtonLabel(['up_to_date'])).toBe('Reinstall');
    expect(installButtonLabel(['changed'])).toBe('Reinstall');
    expect(installButtonLabel(['update_available', 'up_to_date'])).toBe('Update and reinstall');
    expect(installButtonLabel(['not_installed', 'update_available'])).toBe('Install and update');
    expect(installButtonLabel([undefined])).toBe('Install');
  });
});
