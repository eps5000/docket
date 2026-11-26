/**
 * Every place a contextual "?" can sit (UI_SPEC §6.7c), and where it is.
 * An article claims an anchor by listing it in its front matter `anchors`;
 * a screen places it with `<HelpLink anchor="…" />`.
 *
 * `help.test.ts` keeps the three in step: every anchor here is claimed by
 * exactly one article and placed in at least one screen, and every anchor an
 * article names is registered here. So there are no dead "?" links, and no
 * article that says it links from a screen that has no "?".
 */
export const HELP_ANCHORS = {
  'needs-you.page': 'Overview: next to the h1',
  'overview.brief': 'Daily brief: next to the h1 (decision 48)',
  'overview.token-use': 'Overview: the Token use card (decision 48)',
  'item.token-use': 'Ticket or epic → Details → Token use (decision 48)',
  'settings.token-use': 'Settings → Connections → Measure token use (decision 48)',
  'needs-you.agents-strip': 'Overview: the Agents card',
  'needs-you.for-you': 'Needs you: For you now',
  'problems.stale_run': 'Problems row: stale run',
  'problems.failed_run': 'Problems row: failed run',
  'problems.cycle': 'Problems row: dependency cycle',
  'problems.date_risk': 'Problems row: date risk',
  'problems.canceled_blocker': 'Problems row: canceled blocker',
  'problems.deferred_verified_blocker': 'Problems row: a verified blocker with a deferred check',
  'problems.orphaned_resources': 'Problems row: orphaned resources',
  'problems.unpushed_work': 'Problems row: work left in a worktree',
  'problems.parked_too_long': 'Problems row: parked for 24 h',
  'problems.wait_missing_wake': 'Problems row: coordinator wake missing or overdue',
  'problems.dispatch_custody': 'Problems row: Orca dispatch custody',
  'problems.dispatch_resources': 'Problems row: completed Orca dispatch resources',
  'problems.resume_unattended': 'Problems row: ready to resume, unattended',
  'problems.wait_no_next_step': 'Problems row: waiting, with no next step',
  'problems.wait_owner_unasked': 'Problems row: waiting on a decision nobody asked for',
  'problems.extra_backup_failed': 'Problems row: extra backup copy failed',
  'problems.backup_missed': 'Problems row: the nightly backup failed or is overdue',
  'problems.agent_files_drift': 'Problems row: agent files changed outside Docket',
  'problems.radar_conflict': 'Problems row: heading for a merge conflict (decision 36)',
  'problems.idle_ticket': 'Problems row: In progress, but nobody is on it (decision 62)',
  'needs-you.shared-questions': 'Needs you: overlap and undeclared-changes cards (decision 36)',
  'needs-you.agent-problems': 'Overview → Health: "Agents are handling N problems" (decision 37)',
  'needs-you.resolutions': 'Needs you: a proposed resolution card (decision 37)',
  'item.problem-banner': 'Ticket: the problem banner (decision 37)',
  'item.shared-changes': 'Ticket → Details → Shared changes (decision 36)',
  'settings.shared-parts': 'Settings → Projects → Shared parts: the registry and the radar',
  'settings.overlap-handling': 'Settings → Overlap handling (decision 39)',
  'agents.active-now': 'Agents → Active now',
  'agents.workspaces': 'Agents → Workspaces',
  'map.criticalPath': 'Map → What’s holding up',
  'agents.recent': 'Agents → Recent',
  'item.agent-bar': 'Ticket or Epic: the agent bar ("Lead agent")',
  'item.question': 'Ticket: the open question banner',
  'item.lead-and-runs': 'Ticket or Epic → Activity → Lead and runs',
  'item.history': 'Ticket → Activity → History (the note box)',
  'item.work': 'Ticket → Checklist → Work (steps and the step dialog)',
  'item.human-review': 'Ticket → Checklist → Human review',
  'item.dependencies': 'Ticket → Dependencies',
  'item.dates': 'Ticket → Details → Dates and effort',
  'decisions.section': 'Decisions sections (ticket, epic, label, project)',
  'decisions.project-page': 'A project’s Decisions page: next to the h1 (decision 38)',
  'needs-you.project-decisions': 'Needs you: an agent’s project-wide decision card (decision 38)',
  'review.packet': 'Human review packet: next to the h1',
  'work.burndown': 'Work → Timeline → Remaining effort',
  'settings.clients': 'Settings → Connections → Client compatibility',
  'settings.client-setup': 'Settings → Connections → Client setup',
  'settings.service-health': 'Settings → Connections → Service health',
  'settings.security': 'Settings → Connections → Security (the trust mode)',
  'settings.github': 'Settings → Connections → GitHub (decision 49)',
  'item.github': 'Ticket → Details → GitHub (decision 49)',
  'settings.blocker-rule': 'Settings → Projects → Blockers clear when',
  'work.pick-next-epic': 'Work → Pick next epic (decision 54)',
  'settings.pause-project': 'The Paused banner, and Settings → Projects → Pause (decision 53)',
  'agent-files.page': 'Agent files: next to the h1',
  'agent-files.workflow': 'Agent files (one project): the Workflow notes card',
  'agent-files.install-log': 'Agent files: the install log',
  'agent-files.install-state': 'Agent files: the install state card (decision 34)',
  'settings.push-folder': 'Settings → One-click install: the push folder card',
  'jira.import': 'Settings → Projects → Import from Jira (the dialog)',
  'settings.new-project': 'Settings → Projects → New project: "Onboard it with an agent"',
  'needs-you.onboarding': 'Needs you: the onboarding review card',
  'needs-you.welcome': 'Needs you with no projects: the Welcome page (B32)',
} as const;

export type HelpAnchor = keyof typeof HELP_ANCHORS;

export function isHelpAnchor(value: string): value is HelpAnchor {
  return Object.prototype.hasOwnProperty.call(HELP_ANCHORS, value);
}
