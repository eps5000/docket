/**
 * Jira import types (BUILD_SPEC §9): the parts of Jira Cloud REST v3 the
 * importer reads, and the plan the dry run builds in memory.
 *
 * Jira's responses are typed loosely on purpose: fields can be missing or
 * null on any site, and the mapper treats every value as untrusted.
 */
import type { ItemType } from '@docket/shared';

// ---- Jira REST v3 (the subset read) ----

/** Atlassian Document Format: descriptions and comment bodies. */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

export interface JiraUser {
  accountId?: string;
  displayName?: string;
}

export interface JiraField {
  id: string;
  name: string;
  custom?: boolean;
  schema?: { type?: string; custom?: string };
}

export interface JiraLink {
  id: string;
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: { key?: string };
  outwardIssue?: { key?: string };
}

export interface JiraAttachment {
  id: string | number;
  filename?: string;
  size?: number;
  mimeType?: string;
}

export interface JiraComment {
  id: string | number;
  author?: JiraUser | null;
  created?: string;
  body?: AdfNode | string | null;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

/** Everything the dry run read, in memory only. */
export interface JiraSnapshot {
  /** The site origin, `https://…`. */
  site: string;
  project: { key: string; name: string };
  fields: JiraField[];
  /** In key order. */
  issues: JiraIssue[];
  /** Every comment, by issue key (the search embeds only the first few). */
  comments: Record<string, JiraComment[]>;
}

// ---- The import plan (built by the mapper, committed in one transaction) ----

export type ImportStatus = 'inbox' | 'progress' | 'done';

export interface PlannedStep {
  jira_key: string;
  text: string;
  state: 'todo' | 'current' | 'done';
}

export interface PlannedComment {
  jira_id: string;
  author: string;
  /** Jira's creation time, kept as data (the event is stamped at import time). */
  created: string | null;
  text: string;
}

export interface PlannedAttachment {
  jira_id: string;
  name: string;
  size: number;
  mime: string;
}

export interface PlannedItem {
  jira_key: string;
  type: ItemType;
  title: string;
  description_md: string;
  status: ImportStatus;
  priority: 1 | 2 | 3;
  /** The epic's Jira key; it is imported too. */
  epic_key: string | null;
  labels: string[];
  planned_start: string | null;
  planned_end: string | null;
  effort: number | null;
  steps: PlannedStep[];
  comments: PlannedComment[];
  attachments: PlannedAttachment[];
  /** Jira's own facts, carried as event data (never as event times). */
  jira: {
    type: string;
    status: string;
    priority: string | null;
    created: string | null;
    updated: string | null;
    resolved: string | null;
  };
}

export interface PlannedLink {
  /** For `blocks`, `from` blocks `to`. Jira keys. */
  from: string;
  to: string;
  type: 'blocks' | 'relates';
  /** The Jira link type names folded into this link. */
  jira_types: string[];
}

/** What happened to one Jira issue: 100% of issues get one. */
export interface IssueOutcome {
  key: string;
  title: string;
  outcome: 'item' | 'step' | 'skipped';
  /** Why it was skipped, or what it lost. */
  reasons: string[];
}

export interface FieldsUsed {
  story_points: string | null;
  start_date: string | null;
  due_date: string | null;
}

export interface Tally {
  count: number;
  lossy: number;
}

export interface FieldTally {
  mapped: number;
  skipped: number;
  lossy: number;
}

export interface ImportPlan {
  jira_project: string;
  /** Imported items, in Jira key order. */
  items: PlannedItem[];
  links: PlannedLink[];
  outcomes: IssueOutcome[];
  fields_used: FieldsUsed;
  /** "Jira → Docket" rows, in display order. */
  mapping: Map<string, { jira: string; docket: string } & Tally>;
  fields: Map<string, FieldTally>;
  attachments_skipped: { key: string; name: string; reason: string }[];
}
