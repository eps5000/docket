import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button, Callout, Card, Chip, Skeleton } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { CopyBlock, errorText, usePushTarget } from '../agent-files/install-common';

/*
 * The push folder card (UI_SPEC §6.7b, §6.7; FR-125): service setup, so it
 * lives on Settings → General. Agent files links here ("Set up one-click
 * install") while push isn't configured.
 */

const looksWindows = () =>
  typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);

export function PushFolderCard() {
  const query = usePushTarget();
  const qc = useQueryClient();
  const folderId = useId();
  const [folder, setFolder] = useState(looksWindows() ? 'C:/Users/you/code' : '~/code');
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await apiClient['pushTarget.test']({}));
      void qc.invalidateQueries({ queryKey: queryKeys.pushTarget() });
    } catch (err) {
      setTest({ ok: false, message: errorText(err) });
    } finally {
      setTesting(false);
    }
  };
  const f = folder.trim() || 'C:/Users/you/code';
  const volume = `      - ${f}:/host-code`;
  const env = `DOCKET_PUSH_ROOT=/host-code\nDOCKET_PUSH_HOST_PATH=${f}`;
  const override = `services:\n  tasklite:\n    volumes:\n      - ${f}:/host-code\n    environment:\n      DOCKET_PUSH_ROOT: /host-code\n      DOCKET_PUSH_HOST_PATH: ${f}`;

  return (
    <Card padded data-card="push-folder">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="withhelp">
          <h3 style={{ margin: 0 }}>Push folder</h3>
          <HelpLink anchor="settings.push-folder" />
        </div>
        <QueryState query={query} skeleton={<span />}>
          {(t) =>
            !t.configured ? (
              <Chip kind="neutral">Not set up</Chip>
            ) : t.writable ? (
              <Chip kind="ok">Ready</Chip>
            ) : (
              <Chip kind="bad">Not writable</Chip>
            )
          }
        </QueryState>
      </div>
      <p className="src" style={{ margin: '6px 0 10px' }}>
        Mount your code folder into Task Lite so it can install files for you. Without it, Install
        gives you a command to paste instead; both work.
      </p>
      <QueryState query={query} skeleton={<Skeleton lines={2} label="Loading the push folder" />}>
        {(t) => (
          <div className="inform">
            {t.configured && (
              <dl className="inpaths">
                <dt>On your computer</dt>
                <dd className="mono">
                  {t.host_path ?? '(not given: set DOCKET_PUSH_HOST_PATH)'}
                </dd>
                <dt>Inside Task Lite</dt>
                <dd className="mono">{t.container_path}</dd>
              </dl>
            )}
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" onClick={() => void runTest()} disabled={testing}>
                {testing ? 'Testing…' : 'Test'}
              </Button>
              <span className="src">Writes a small test file there and removes it.</span>
            </div>
            {test && (
              <Callout tone={test.ok ? 'ok' : 'bad'} role="status">
                {test.message}
              </Callout>
            )}
            {!t.configured && (
              <div className="inhow" data-push-howto="">
                <h4>Set it up (about 2 minutes)</h4>
                <div className="infield instack">
                  <label htmlFor={folderId} className="inlabel">
                    Your code folder (the one that holds your repos)
                  </label>
                  <input
                    id={folderId}
                    className="input mono"
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                  />
                  <span className="src">The steps below update as you type.</span>
                </div>
                <ol>
                  <li>
                    Open <code>docker/compose.yaml</code> in the folder you installed Task Lite
                    from. Under <code>volumes:</code>, below <code>- tasklite-data:/data</code>, add
                    this line (keep the indentation):
                    <CopyBlock text={volume} label="compose.yaml line" what="volume line" />
                  </li>
                  <li>
                    In the same <code>docker</code> folder, open <code>.env</code> (create it if it
                    isn’t there) and add:
                    <CopyBlock text={env} label=".env lines" what=".env lines" />
                  </li>
                  <li>
                    Restart Task Lite:
                    <CopyBlock
                      text="docker compose -f docker/compose.yaml up -d"
                      label="Terminal, in the Task Lite folder"
                      what="restart command"
                    />
                  </li>
                  <li>Come back here and click Test.</li>
                </ol>
                <details>
                  <summary>Rather not edit compose.yaml? Use an override file instead</summary>
                  <p className="src">
                    Save this as <code>docker/compose.push.yaml</code>, then start Task Lite with
                    both files. Upgrades never touch it.
                  </p>
                  <CopyBlock
                    text={override}
                    label="docker/compose.push.yaml"
                    what="override file"
                  />
                  <CopyBlock
                    text="docker compose -f docker/compose.yaml -f docker/compose.push.yaml up -d"
                    label="Start command"
                    what="start command"
                  />
                </details>
                <p className="src">
                  Task Lite writes there only the skill folders, its manifest and the marked Task
                  Lite section of AGENTS.md or CLAUDE.md, and never deletes anything. On Linux, the
                  folder must be writable by Task Lite’s user (uid 10001), for example{' '}
                  <code>sudo setfacl -R -m u:10001:rwX ~/code</code>.
                </p>
              </div>
            )}
          </div>
        )}
      </QueryState>
    </Card>
  );
}
