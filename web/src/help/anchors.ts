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
  'needs-you.page': 'Needs you: next to the h1',
  'needs-you.agents-strip': 'Needs you: the Agents strip',
  'needs-you.for-you': 'Needs you: For you now',
  'problems.stale_run': 'Problems row: stale run',
  'problems.failed_run': 'Problems row: failed run',
  'problems.cycle': 'Problems row: dependency cycle',
  'problems.date_risk': 'Problems row: date risk',
  'problems.canceled_blocker': 'Problems row: canceled blocker',
  'problems.deferred_verified_blocker': 'Problems row: a verified blocker with a deferred check',
  'problems.orphaned_resources': 'Problems row: orphaned resources',
  'problems.unpushed_work': 'Problems row: unpushed work may be lost',
  'problems.parked_too_long': 'Problems row: parked for 24 h',
  'problems.resume_unattended': 'Problems row: ready to resume, unattended',
  'problems.extra_backup_failed': 'Problems row: extra backup copy failed',
  'problems.agent_files_drift': 'Problems row: agent files changed outside Docket',
  'agents.active-now': 'Agents → Active now',
  'agents.workspaces': 'Agents → Workspaces',
  'agents.recent': 'Agents → Recent',
  'item.agent-bar': 'Ticket: the agent bar ("Lead agent")',
  'item.question': 'Ticket: the open question banner',
  'item.lead-and-runs': 'Ticket → Activity → Lead and runs',
  'item.history': 'Ticket → Activity → History (the note box)',
  'item.human-review': 'Ticket → Checklist → Human review',
  'item.dependencies': 'Ticket → Dependencies',
  'item.dates': 'Ticket → Details → Dates and effort',
  'decisions.section': 'Decisions sections (ticket, epic, label, project)',
  'review.packet': 'Human review packet: next to the h1',
  'work.burndown': 'Work → Timeline → Remaining effort',
  'settings.clients': 'Settings → Connections → Client compatibility',
  'settings.client-setup': 'Settings → Connections → Client setup',
  'settings.service-health': 'Settings → Connections → Service health',
  'settings.security': 'Settings → Connections → Security (the trust mode)',
  'settings.blocker-rule': 'Settings → Projects → Blockers clear when',
  'agent-files.page': 'Agent files: next to the h1',
  'agent-files.workflow': 'Agent files (one project): the Workflow notes card',
  'agent-files.install-log': 'Agent files: the install log',
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
