import { useId, useState } from 'react';
import { Button, Dialog, DialogCancel } from '../../components/kit';

type Step = 1 | 2 | 3;

/**
 * Jira import (UI_SPEC §9.2): three steps, "1 Connect · 2 Review · 3
 * Import", with *Back* on step 2. The shell renders step 1's form; US9 fills
 * the dry run (`POST /api/import/jira/dry-run`), the report and the import.
 * The API token is never kept after step 1.
 */
export function JiraImportDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>(1);
  const ids = { site: useId(), email: useId(), token: useId(), key: useId() };
  return (
    <Dialog
      title="Import from Jira"
      onClose={onClose}
      footer={
        <>
          {step === 2 && <Button onClick={() => setStep(1)}>Back</Button>}
          <DialogCancel onClick={onClose} />
          {step === 1 && (
            <Button variant="primary" disabled title="Lands with US9">
              Run dry run
            </Button>
          )}
        </>
      }
    >
      <ol className="steps" aria-label="Steps">
        {(['Connect', 'Review', 'Import'] as const).map((s, i) => (
          <li key={s} aria-current={step === i + 1 ? 'step' : undefined}>
            {i + 1} {s}
          </li>
        ))}
      </ol>
      {step === 1 && (
        <div>
          <label className="f" htmlFor={ids.site}>
            Jira site
          </label>
          <input
            id={ids.site}
            className="input"
            placeholder="https://yoursite.atlassian.net"
            autoComplete="off"
          />
          <label className="f" htmlFor={ids.email}>
            Email
          </label>
          <input id={ids.email} className="input" type="email" autoComplete="off" />
          <label className="f" htmlFor={ids.token}>
            API token
          </label>
          <input id={ids.token} className="input" type="password" autoComplete="off" />
          <div className="src">Used for this import only. Not saved.</div>
          <label className="f" htmlFor={ids.key}>
            Jira project key
          </label>
          <input id={ids.key} className="input" autoComplete="off" />
        </div>
      )}
    </Dialog>
  );
}
