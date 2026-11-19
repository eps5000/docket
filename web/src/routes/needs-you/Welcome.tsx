import { Link } from 'react-router';
import { Button, Callout } from '../../components/kit';
import { useShell } from '../../app/ShellState';
import { HelpLink } from '../../help/HelpLink';
import { paths } from '../../lib/paths';
import { CopyBlock } from '../agent-files/install-common';
import { onboardLine } from '../dialogs/NewProject';

/**
 * The Welcome page (UI_SPEC §6.0 "First run"; B32): what Needs you shows
 * while there are no projects (deleted ones don't count). Three ways to
 * start (create a project, import one from Jira, or have an agent onboard
 * a repo), a line on how Docket works, and Help.
 */
export function Welcome() {
  const { setProjectDialog } = useShell();
  return (
    <div className="welcome">
      <div className="withhelp wh-h1">
        <h1>Welcome to Docket</h1>
        <HelpLink anchor="needs-you.welcome" />
      </div>
      <p className="welcome-lede">The shared record your AI agents work from.</p>

      <ol className="welcome-starts" aria-label="Ways to start">
        <li className="card pad">
          <h2>Create a project</h2>
          <p className="src">
            Start empty: give it a key and a name, then add items yourself or let an agent fill it.
          </p>
          <Button variant="primary" icon="plus" onClick={() => setProjectDialog({ kind: 'new' })}>
            New project
          </Button>
        </li>
        <li className="card pad">
          <h2>Import from Jira</h2>
          <p className="src">
            Copy a Jira Cloud project into a new Docket project, after a dry run that shows what
            comes across.
          </p>
          <Button onClick={() => setProjectDialog({ kind: 'jira' })}>Import from Jira…</Button>
        </li>
        <li className="card pad">
          <h2>Onboard a repo with an agent</h2>
          <p className="src">
            An agent reads the repo’s specs, plans and docs and sets the project up in Planning, for
            you to review. Replace <span className="mono">&lt;KEY&gt;</span> with 2–5 letters, like
            GF.
          </p>
          <CopyBlock
            text={onboardLine('<KEY>')}
            label="Give a connected agent this line, in the repo’s folder"
            what="line"
          />
          <p className="src">
            Or run the <span className="mono">onboard</span> prompt with the key.
          </p>
          <Callout className="welcome-note">
            The agent needs to be connected first: see{' '}
            <Link to={paths.help('connect-an-agent')}>Connect an agent</Link>.
          </Callout>
        </li>
      </ol>

      <p className="welcome-how">
        <b>How Docket works:</b> you or your agents add the work; agents claim items, log what they
        do and hand finished work back to you for review; you decide here, on Needs you. Docket
        doesn’t start agents. <Link to={paths.help()}>Read Help</Link>
      </p>
    </div>
  );
}

/**
 * What Work, Agents and Agent files show instead of their empty states while
 * there are no projects (B32): one line pointing at the Welcome page.
 */
export function NoProjectsPointer() {
  return (
    <p className="noprojects" data-first-run>
      No projects yet. <Link to={paths.needsYou()}>Start on the Welcome page</Link> to create one,
      import one from Jira, or have an agent onboard a repo.
    </p>
  );
}
