import '../screens.css';
import { RunsCard } from './RunsCard';
import { WorkspacesCard } from './WorkspacesCard';

/**
 * Agents (`/agents`, UI_SPEC §6.6): the runs table, then the Workspaces card
 * (owner decision 26). US2 (T084) fills the runs; US11 fills Workspaces.
 */
export function Agents() {
  return (
    <div className="agents stack">
      <h1>Agents</h1>
      <RunsCard />
      <WorkspacesCard />
    </div>
  );
}
