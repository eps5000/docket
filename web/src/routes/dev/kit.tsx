/**
 * The kit gallery (`/dev/kit`, tasks.md T058): every kit component in every
 * variant and state, in both themes side by side. Dev and test builds only
 * (app/router.tsx); axe runs on it in web/e2e/kit.spec.ts.
 */
import { useState, type ReactNode } from 'react';
import {
  HUMAN_REVIEW_STATES,
  ITEM_TYPES,
  PRIORITIES,
  RUN_STATES,
  STATUSES,
  WORKSPACE_STATES,
  type DecisionRecord,
  type EpicCard as EpicCardData,
  type WorkItem,
} from '@tasklite/shared';
import {
  BlockedChip,
  Button,
  Callout,
  Card,
  CardHeader,
  Chip,
  CommandPalette,
  DecisionAuthorityBadge,
  DecisionRow,
  Dialog,
  DialogCancel,
  EditableText,
  EmptyState,
  EpicCard,
  EpicLink,
  ErrorState,
  FilterChip,
  HumanReviewChip,
  IconButton,
  InlineEditor,
  Label,
  Priority,
  PROVENANCE,
  Provenance,
  RunState,
  Section,
  SegmentedControl,
  Skeleton,
  StatusChip,
  TicketCard,
  Toast,
  TypeBadge,
  TypeIcon,
  ViewTabs,
  WorkspaceStateChip,
  type ProvenanceKind,
} from '../../components/kit';
import { applyTheme, readTheme, type Theme } from '../../app/ShellState';
import { toasts, useToasts } from '../../lib/undo';
import { ToastRegion } from '../../components/kit';
import '../screens.css';
import './kit.css';

// ---- Fixtures (shapes from design/sample-data.json) ----

const NOW = new Date('2026-11-06T11:00:00Z');
const base: WorkItem = {
  id: 'RCP-14',
  project: 'RCP',
  type: 'Story',
  title: 'Generate shopping list from week plan',
  status: 'progress',
  priority: 1,
  epic: 'RCP-1',
  epic_title: 'Meal planning MVP',
  labels: ['mobile'],
  blocked: false,
  blocked_by: [],
  unblocks: 2,
  lead: { client: 'claude', label: 'orca-w3', run_id: 'r-61', run_state: 'live' },
  human_review: { declared: 1, ready: 0, approved: 0, deferred: 0 },
  planned_start: '2026-11-04',
  planned_end: '2026-11-11',
  effort: 5,
  archived: false,
  jira_key: null,
  version: 3,
  updated_at: '2026-11-06T10:59:20Z',
  packet_ready: false,
  for_you: false,
  last_activity_at: '2026-11-06T10:59:20Z',
};
const CARDS: { label: string; item: WorkItem }[] = [
  { label: 'default (claimed, live)', item: base },
  {
    label: 'unclaimed (no run line)',
    item: {
      ...base,
      id: 'RCP-20',
      title: 'Offline mode spike',
      status: 'inbox',
      lead: null,
      epic: null,
      epic_title: null,
      labels: [],
      human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
    },
  },
  {
    label: 'blocked',
    item: {
      ...base,
      id: 'RCP-16',
      title: 'Nutrition summary card',
      status: 'ready',
      blocked: true,
      blocked_by: ['DOC-4', 'RCP-19'],
      lead: null,
    },
  },
  {
    label: 'for you (packet ready)',
    item: {
      ...base,
      id: 'RCP-12',
      title: 'Weekly planner drag-and-drop',
      status: 'review',
      packet_ready: true,
      for_you: true,
      lead: { client: 'codex', label: null, run_id: 'r-50', run_state: 'finished' },
      human_review: { declared: 0, ready: 2, approved: 0, deferred: 0 },
    },
  },
  {
    label: 'done (+ Archive)',
    item: {
      ...base,
      id: 'RCP-11',
      type: 'Task',
      title: 'Auth scaffold',
      status: 'done',
      lead: { client: 'codex', label: null, run_id: 'r-40', run_state: 'finished' },
      human_review: { declared: 0, ready: 0, approved: 0, deferred: 1 },
    },
  },
];
const EPIC: EpicCardData = {
  ...base,
  id: 'RCP-1',
  type: 'Epic',
  title: 'Meal planning MVP',
  epic: null,
  epic_title: null,
  lead: null,
  children: {
    total: 12,
    done: 3,
    by_status: { done: 3, progress: 2, review: 2, ready: 4, planning: 1 },
  },
};
const decision = (over: Partial<DecisionRecord>): DecisionRecord => ({
  id: 'dec-1',
  project: 'RCP',
  scope: { kind: 'project', id: null },
  title: 'Quantities use metric units in storage',
  decision_md:
    'Store every quantity in grams or millilitres and convert only for display. Recipes imported in cups are converted on import, and the original text is kept beside the converted value so nothing is lost.',
  rationale_md: 'One unit system keeps the merge logic simple and testable.',
  authority: 'owner',
  author: 'owner',
  status: 'active',
  supersedes_id: null,
  superseded_by_id: null,
  created_at: '2026-11-02T09:00:00Z',
  confirmed_at: null,
  version: 1,
  ...over,
});

// ---- Layout helpers ----

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="kitgroup" aria-label={title}>
      <h2>{title}</h2>
      <div className="kitbody">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kitrow">
      <span className="src kitlabel">{label}</span>
      <div className="row wrap">{children}</div>
    </div>
  );
}

/** Every component, every variant and state, in one theme. */
function Gallery({ theme }: { theme: 'light' | 'dark' }) {
  const [tab, setTab] = useState<'details' | 'checklist' | 'deps' | 'activity'>('details');
  const [seg, setSeg] = useState<'board' | 'list' | 'map' | 'timeline'>('board');
  const [chip, setChip] = useState(true);
  const t = (s: string) => `${s} (${theme})`;
  return (
    <div className="tl kitpane" data-theme={theme} data-kit-theme={theme}>
      <h1>{theme === 'light' ? 'Light' : 'Dark'}</h1>

      <Group title={t('Button')}>
        <Row label="md">
          <Button variant="primary">Approve and close ticket</Button>
          <Button>Move to Planning</Button>
          <Button variant="ghost">Show</Button>
          <Button variant="danger-text">Delete…</Button>
          <Button variant="danger">Release claim</Button>
          <Button icon="promote">Move to Ready</Button>
        </Row>
        <Row label="sm">
          <Button size="sm" variant="primary">
            Open packet
          </Button>
          <Button size="sm">Archive</Button>
          <Button size="sm" variant="ghost">
            Archive all
          </Button>
          <Button size="sm" variant="danger-text">
            Withdraw…
          </Button>
        </Row>
        <Row label="disabled">
          <Button variant="primary" disabled>
            Decide every item first
          </Button>
          <Button disabled>Add</Button>
        </Row>
        <Row label="IconButton">
          <IconButton icon="sun" aria-label="Theme: light. Switch theme" />
          <IconButton icon="x" aria-label="Close" bare />
          <IconButton icon="more" aria-label="More actions" />
          <IconButton icon="copy" aria-label="Copy path" disabled />
        </Row>
        <Row label="SegmentedControl">
          <SegmentedControl
            label={t('Layout')}
            value={seg}
            onChange={setSeg}
            options={[
              { key: 'board', label: 'Board' },
              { key: 'list', label: 'List' },
              { key: 'map', label: 'Map' },
              { key: 'timeline', label: 'Timeline' },
            ]}
          />
        </Row>
        <Row label="FilterChip">
          <FilterChip
            label="All"
            count={21}
            pressed={chip}
            onClick={() => setChip(!chip)}
            title="Agent query: "
          />
          <FilterChip
            label="Blocked"
            count={4}
            pressed={!chip}
            onClick={() => setChip(!chip)}
            title="Agent query: is:blocked"
          />
        </Row>
      </Group>

      <Group title={t('Chip')}>
        <Row label="status (7)">
          {STATUSES.map((s) => (
            <StatusChip key={s} status={s} />
          ))}
        </Row>
        <Row label="blocked">
          <BlockedChip blockers={['RCP-12']} />
          <BlockedChip blockers={['RCP-12']} waitingFor="merge" />
          <BlockedChip blockers={['RCP-12']} waitingFor="verification" />
          <BlockedChip blockers={['DOC-4', 'RCP-19']} />
        </Row>
        <Row label="human review (4)">
          {HUMAN_REVIEW_STATES.map((s) => (
            <HumanReviewChip key={s} state={s} />
          ))}
        </Row>
        <Row label="tones">
          <Chip kind="neutral">lead</Chip>
          <Chip kind="warn" icon="packet">
            Packet ready
          </Chip>
          <Chip kind="ok">✓ Verified</Chip>
          <Chip kind="bad">Date risk</Chip>
          <Chip kind="info" icon="pause">
            Review deferred
          </Chip>
        </Row>
        <Row label="workspace state">
          {WORKSPACE_STATES.map((s) => (
            <WorkspaceStateChip key={s} state={s} />
          ))}
        </Row>
      </Group>

      <Group title={t('TypeBadge and TypeIcon')}>
        <Row label="badge">
          {ITEM_TYPES.map((ty) => (
            <TypeBadge key={ty} type={ty} />
          ))}
        </Row>
        <Row label="icon only">
          {ITEM_TYPES.map((ty) => (
            <TypeIcon key={ty} type={ty} />
          ))}
        </Row>
      </Group>

      <Group title={t('RunState')}>
        <Row label="every state">
          {RUN_STATES.map((s) => (
            <RunState key={s} state={s} age="40s" />
          ))}
        </Row>
        <Row label="parked">
          <RunState state="parked" detail="waiting on RCP-12" />
          <RunState state="parked" detail="waiting on the coordinator" age="2h" />
        </Row>
      </Group>

      <Group title={t('Provenance and decision authority')}>
        <Row label="provenance">
          {(Object.keys(PROVENANCE) as ProvenanceKind[]).map((k) => (
            <Provenance key={k} kind={k} />
          ))}
        </Row>
        <Row label="with label">
          <Provenance kind="owner_approve" label="Looked good" />
          <Provenance kind="owner_changes" label="Needed changes" />
          <Provenance kind="owner_defer" label="Deferred · not verified" />
          <Provenance kind="agent" label="Agent-reported · no heartbeat" />
        </Row>
        <Row label="authority">
          <DecisionAuthorityBadge authority="owner" />
          <DecisionAuthorityBadge authority="agent" agent="claude" />
        </Row>
      </Group>

      <Group title={t('Priority, Label, EpicLink')}>
        <Row label="priority">
          {PRIORITIES.map((p) => (
            <Priority key={p} p={p} />
          ))}
        </Row>
        <Row label="label">
          <Label project="RCP" name="ui-refresh" />
          <Label project="RCP" name="mobile" asLink={false} />
        </Row>
        <Row label="epic link">
          <EpicLink epic={{ id: 'RCP-1', title: 'Meal planning MVP' }} />
          <EpicLink epic={{ id: 'RCP-2', title: 'Pantry' }} asLink={false} />
        </Row>
      </Group>

      <Group title={t('Card, Callout, EmptyState, Skeleton, ErrorState')}>
        <div className="kitgrid">
          <Card>
            <CardHeader title="Problems · 0" />
            <EmptyState text="No stale or failed runs, cycles or date conflicts." />
          </Card>
          <Card padded>
            <h3>Padded card</h3>
            <Skeleton lines={3} delayMs={0} />
          </Card>
        </div>
        <Row label="callouts">
          <Callout>Tip: pick an epic or label above. A whole project on one map gets busy.</Callout>
          <Callout tone="warn">Backups keep a copy until their 14-day retention ends.</Callout>
          <Callout tone="bad">In a dependency cycle (DOC-7 ⇄ DOC-8).</Callout>
          <Callout tone="ok">You answered: “Per serving”. Waiting for codex to read it.</Callout>
        </Row>
        <ErrorState
          error={{
            status: 501,
            code: 'unavailable',
            message: 'Not implemented yet: GET /api/needs-you',
          }}
          onRetry={() => undefined}
        />
        <ErrorState
          error={{ status: 500, code: 'internal', message: 'The database is busy. Try again.' }}
          onRetry={() => undefined}
        />
      </Group>

      <Group title={t('Section')}>
        <Section
          sectionKey={`kit-open-${theme}`}
          title="Work"
          summary="2/4 done · the agent’s plan"
          extraHead={
            <Button variant="ghost" size="sm">
              Checklist history
            </Button>
          }
        >
          <div>Steps go here.</div>
        </Section>
        <Section sectionKey={`kit-closed-${theme}`} title="Documents" summary="3">
          <div>Collapse me; I stay collapsed for every “kit-closed” section.</div>
        </Section>
      </Group>

      <Group title={t('ViewTabs')}>
        <ViewTabs
          label={t('Ticket views')}
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'details', label: 'Details' },
            {
              key: 'checklist',
              label: 'Checklist',
              count: '1/4',
              dot: { tone: 'warn', text: 'packet ready' },
            },
            {
              key: 'deps',
              label: 'Dependencies',
              count: 3,
              dot: { tone: 'bad', text: 'in a dependency cycle' },
            },
            { key: 'activity', label: 'Activity', dot: { tone: 'warn', text: 'stale run' } },
          ]}
          extra={<Button size="sm">+ New item in this epic</Button>}
        >
          <div className="src">Panel: {tab}</div>
        </ViewTabs>
      </Group>

      <Group title={t('TicketCard and EpicCard')}>
        <div className="kitcards">
          {CARDS.map((c) => (
            <div key={c.label}>
              <div className="src">{c.label}</div>
              <TicketCard item={c.item} now={NOW} onArchive={() => undefined} />
            </div>
          ))}
          <div>
            <div className="src">epic</div>
            <EpicCard epic={EPIC} forYou={2} />
          </div>
        </div>
      </Group>

      <Group title={t('DecisionRow')}>
        <DecisionRow
          record={decision({})}
          canAct
          scopeLabel="Project"
          onWithdraw={() => undefined}
          onSupersede={() => undefined}
        />
        <DecisionRow
          record={decision({
            id: 'dec-2',
            title: 'Shopping list groups by aisle',
            authority: 'agent',
            author: 'claude',
            rationale_md: null,
          })}
          canAct
          scopeLabel="◆ Meal planning MVP"
          onConfirm={() => undefined}
          onWithdraw={() => undefined}
        />
        <DecisionRow
          record={decision({ id: 'dec-3', title: 'Use cups in the UI', status: 'superseded' })}
          canAct={false}
        />
        <DecisionRow
          record={decision({
            id: 'dec-4',
            title: 'Skip offline mode',
            status: 'withdrawn',
            authority: 'agent',
            author: 'codex',
          })}
          canAct={false}
        />
      </Group>

      <Group title={t('Toast')}>
        <div className="kittoasts">
          <Toast
            toast={{ id: -1, message: 'Saved. Agents see it on their next read.' }}
            onDismiss={() => undefined}
          />
          <Toast
            toast={{ id: -2, message: 'Archived RCP-11.', onUndo: () => undefined }}
            onDismiss={() => undefined}
          />
        </div>
      </Group>

      <Group title={t('Inline editor')}>
        <EditableText
          field={`title (${theme})`}
          value="Weekly planner drag-and-drop"
          maxLength={200}
          onSave={() => true}
        >
          <h1>Weekly planner drag-and-drop</h1>
        </EditableText>
        <InlineEditor
          field={`outcome (${theme})`}
          initial="When a week plan is saved, the user can produce one merged shopping list."
          multiline
          maxLength={120}
          onSave={() => true}
          onCancel={() => undefined}
          conflict={
            <Callout tone="warn">
              codex changed this at 10:52. Their version is shown above; your text is kept below to
              copy back.
            </Callout>
          }
        />
      </Group>
    </div>
  );
}

/** Overlays render on the page, in the body theme: open them from here. */
function Overlays() {
  const [dialog, setDialog] = useState<'default' | 'destructive' | null>(null);
  const [palette, setPalette] = useState(false);
  const [q, setQ] = useState('');
  return (
    <div className="row wrap">
      <Button onClick={() => setDialog('default')}>Open dialog</Button>
      <Button onClick={() => setDialog('destructive')}>Open destructive dialog</Button>
      <Button onClick={() => setPalette(true)}>Open command palette</Button>
      <Button
        onClick={() => toasts.show('Archived RCP-11.', { onUndo: () => toasts.show('Undone.') })}
      >
        Show toast with Undo
      </Button>
      <Button onClick={() => toasts.show('Give it a title')}>Show info toast</Button>
      {dialog === 'default' && (
        <Dialog
          title="New item in Inbox"
          onClose={() => setDialog(null)}
          footer={
            <>
              <DialogCancel onClick={() => setDialog(null)} />
              <Button variant="primary">Create</Button>
            </>
          }
        >
          <label className="f" htmlFor="kit-title" style={{ marginTop: 0 }}>
            Title
          </label>
          <input id="kit-title" className="input" />
        </Dialog>
      )}
      {dialog === 'destructive' && (
        <Dialog
          title="Release lead claim on RCP-15?"
          destructive
          onClose={() => setDialog(null)}
          footer={
            <>
              <DialogCancel onClick={() => setDialog(null)} />
              <Button variant="danger">Release claim</Button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            codex · orca-w1 has been silent for 47 minutes. Releasing will:
          </p>
          <ul>
            <li>
              mark run r-58 as <b>interrupted</b>, not finished
            </li>
            <li>keep its checklist, log and partial work on the ticket</li>
            <li>move RCP-15 back to Ready so another agent can claim it</li>
          </ul>
          <div className="src">
            If codex comes back, it gets a conflict response with the current state.
          </div>
        </Dialog>
      )}
      {palette && (
        <CommandPalette
          query={q}
          onQueryChange={setQ}
          onClose={() => setPalette(false)}
          groups={[
            {
              label: 'Work items',
              options: [
                {
                  key: 'i1',
                  label: 'RCP-14 Generate shopping list from week plan',
                  meta: <StatusChip status="progress" />,
                  onSelect: () => undefined,
                },
                {
                  key: 'i2',
                  label: 'RCP-11 Auth scaffold',
                  archived: true,
                  meta: <StatusChip status="done" />,
                  onSelect: () => undefined,
                },
              ],
            },
            {
              label: 'Labels',
              options: [{ key: 'l1', label: '# ui-refresh', onSelect: () => undefined }],
            },
            {
              label: 'Go to',
              options: [{ key: 'v1', label: 'Needs you', onSelect: () => undefined }],
            },
          ].map((g) => ({
            ...g,
            options: g.options.filter(
              (o) => !q || String(o.label).toLowerCase().includes(q.toLowerCase()),
            ),
          }))}
        />
      )}
    </div>
  );
}

export default function KitGallery() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const list = useToasts();
  return (
    <div className="kit">
      <header className="kithead">
        <h1>UI kit</h1>
        <span className="src">Dev and test builds only.</span>
        <SegmentedControl<Theme>
          label="Page theme (overlays)"
          value={theme}
          onChange={(v) => {
            setTheme(v);
            applyTheme(v);
          }}
          options={[
            { key: 'system', label: 'System' },
            { key: 'light', label: 'Light' },
            { key: 'dark', label: 'Dark' },
          ]}
        />
      </header>
      <main>
        <Overlays />
        <div className="kitpanes">
          <Gallery theme="light" />
          <Gallery theme="dark" />
        </div>
      </main>
      <ToastRegion toasts={list} onDismiss={toasts.dismiss} />
    </div>
  );
}
