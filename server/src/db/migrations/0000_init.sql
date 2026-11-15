CREATE TABLE `acceptance_criteria` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "acceptance_criteria_text" CHECK(length("text") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE INDEX `acceptance_criteria_item` ON `acceptance_criteria` (`item_id`,`position`);--> statement-breakpoint
CREATE TABLE `agent_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`state` text DEFAULT 'todo' NOT NULL,
	`evidence` text,
	`provenance` text DEFAULT 'agent' NOT NULL,
	`added_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_checks_text" CHECK(length("text") BETWEEN 1 AND 500),
	CONSTRAINT "agent_checks_state" CHECK("state" IN ('todo', 'pass', 'fail', 'skipped')),
	CONSTRAINT "agent_checks_provenance" CHECK("provenance" IN ('agent', 'observed', 'relayed', 'ci'))
);
--> statement-breakpoint
CREATE INDEX `agent_checks_item` ON `agent_checks` (`item_id`,`position`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`url` text,
	`state` text,
	`provenance` text DEFAULT 'agent' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifacts_kind" CHECK("kind" IN ('url', 'pr', 'ci', 'deploy', 'test')),
	CONSTRAINT "artifacts_provenance" CHECK("provenance" IN ('agent', 'observed', 'relayed', 'ci'))
);
--> statement-breakpoint
CREATE INDEX `artifacts_item` ON `artifacts` (`item_id`);--> statement-breakpoint
CREATE TABLE `commits` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`sha` text NOT NULL,
	`branch` text,
	`message` text,
	`pr_url` text,
	`reported_by` text NOT NULL,
	`reported_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "commits_sha" CHECK(length("sha") BETWEEN 7 AND 40 AND lower("sha") NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `commits_item` ON `commits` (`item_id`,`reported_at`);--> statement-breakpoint
CREATE TABLE `decision_records` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text,
	`title` text NOT NULL,
	`decision_md` text NOT NULL,
	`rationale_md` text,
	`authority` text NOT NULL,
	`author` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`supersedes_id` text,
	`confirmed_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supersedes_id`) REFERENCES `decision_records`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "decision_records_scope_kind" CHECK("scope_kind" IN ('project', 'epic', 'label', 'item')),
	CONSTRAINT "decision_records_authority" CHECK("authority" IN ('owner', 'agent')),
	CONSTRAINT "decision_records_status" CHECK("status" IN ('active', 'superseded', 'withdrawn')),
	CONSTRAINT "decision_records_title" CHECK(length("title") BETWEEN 1 AND 120),
	CONSTRAINT "decision_records_decision_md" CHECK(length("decision_md") BETWEEN 1 AND 4000),
	CONSTRAINT "decision_records_scope_id" CHECK(("scope_kind" = 'project') = ("scope_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `decision_records_scope` ON `decision_records` (`project_key`,`scope_kind`,`scope_id`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`path` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "document_versions_size" CHECK("size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_doc_version` ON `document_versions` (`document_id`,`version_no`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`item_id` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "documents_kind" CHECK("kind" IN ('planning', 'packet_attachment', 'import_report', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_item_name` ON `documents` (`item_id`,`name`);--> statement-breakpoint
CREATE INDEX `documents_project` ON `documents` (`project_key`);--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_kind` text NOT NULL,
	`client` text,
	`label` text,
	`run_id` text,
	`project_key` text,
	`item_id` text,
	`type` text NOT NULL,
	`summary` text NOT NULL,
	`data` text,
	`inverse` text,
	`mutation_id` text NOT NULL,
	`idempotency_key` text,
	CONSTRAINT "events_actor_kind" CHECK("actor_kind" IN ('owner', 'agent', 'system'))
);
--> statement-breakpoint
CREATE INDEX `events_mutation` ON `events` (`mutation_id`);--> statement-breakpoint
CREATE INDEX `events_item` ON `events` (`item_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_project` ON `events` (`project_key`,`seq`);--> statement-breakpoint
CREATE TABLE `hr_items` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`state` text DEFAULT 'declared' NOT NULL,
	`added_by` text NOT NULL,
	`last_decision` text,
	`follow_up_item_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`follow_up_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "hr_items_text" CHECK(length("text") BETWEEN 1 AND 500),
	CONSTRAINT "hr_items_state" CHECK("state" IN ('declared', 'ready', 'approved', 'deferred'))
);
--> statement-breakpoint
CREATE INDEX `hr_items_item` ON `hr_items` (`item_id`,`position`);--> statement-breakpoint
CREATE TABLE `idempotency` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`client` text NOT NULL,
	`request_hash` text NOT NULL,
	`response` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "idempotency_key_length" CHECK(length("key") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_client_key` ON `idempotency` (`client`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_expires` ON `idempotency` (`expires_at`);--> statement-breakpoint
CREATE TABLE `item_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`label_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_labels_item_label` ON `item_labels` (`item_id`,`label_id`);--> statement-breakpoint
CREATE INDEX `item_labels_label` ON `item_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description_md` text DEFAULT '' NOT NULL,
	`outcome_md` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 2 NOT NULL,
	`epic_id` text,
	`planned_start` text,
	`planned_end` text,
	`dates_set_by` text,
	`dates_set_at` text,
	`effort` real,
	`effort_unit` text DEFAULT 'pts' NOT NULL,
	`closed_by` text,
	`closed_at` text,
	`archived_at` text,
	`jira_key` text,
	`imported` integer DEFAULT false NOT NULL,
	`from_review` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epic_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "items_type" CHECK("type" IN ('Epic', 'Story', 'Task', 'Bug')),
	CONSTRAINT "items_status" CHECK("status" IN ('inbox', 'planning', 'ready', 'progress', 'review', 'done', 'canceled')),
	CONSTRAINT "items_priority" CHECK("priority" BETWEEN 1 AND 3),
	CONSTRAINT "items_title" CHECK(length("title") BETWEEN 1 AND 200),
	CONSTRAINT "items_description_md" CHECK(length("description_md") <= 20000),
	CONSTRAINT "items_outcome_md" CHECK(length("outcome_md") <= 20000),
	CONSTRAINT "items_effort" CHECK("effort" >= 0),
	CONSTRAINT "items_closed_by" CHECK("closed_by" IN ('owner', 'agent', 'imported')),
	CONSTRAINT "items_epic_not_self" CHECK("epic_id" <> "id")
);
--> statement-breakpoint
CREATE INDEX `items_project_status` ON `items` (`project_key`,`status`);--> statement-breakpoint
CREATE INDEX `items_epic` ON `items` (`epic_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`name` text NOT NULL,
	`brief_md` text DEFAULT '' NOT NULL,
	`brief_by` text,
	`brief_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "labels_name_format" CHECK(length("name") BETWEEN 1 AND 40 AND "name" NOT GLOB '*[^a-z0-9-]*'),
	CONSTRAINT "labels_brief_md" CHECK(length("brief_md") <= 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_project_name` ON `labels` (`project_key`,`name`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`type` text NOT NULL,
	`satisfied_when` text,
	`created_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "links_type" CHECK("type" IN ('blocks', 'relates')),
	CONSTRAINT "links_satisfied_when" CHECK("satisfied_when" IN ('done', 'merged', 'verified')),
	CONSTRAINT "links_not_self" CHECK("from_id" <> "to_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_from_to_type` ON `links` (`from_id`,`to_id`,`type`);--> statement-breakpoint
CREATE INDEX `links_to` ON `links` (`to_id`);--> statement-breakpoint
CREATE TABLE `owner_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`text` text NOT NULL,
	`read_by_agent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "owner_notes_text" CHECK(length("text") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE INDEX `owner_notes_item` ON `owner_notes` (`item_id`);--> statement-breakpoint
CREATE TABLE `owner_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen_at` text NOT NULL,
	`user_agent` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `packet_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`packet_id` text NOT NULL,
	`document_version_id` text NOT NULL,
	`caption` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`packet_id`) REFERENCES `packets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_version_id`) REFERENCES `document_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `packet_items` (
	`id` text PRIMARY KEY NOT NULL,
	`packet_id` text NOT NULL,
	`hr_item_id` text NOT NULL,
	`text_snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`packet_id`) REFERENCES `packets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hr_item_id`) REFERENCES `hr_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packet_items_packet_hr` ON `packet_items` (`packet_id`,`hr_item_id`);--> statement-breakpoint
CREATE TABLE `packets` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`round` integer NOT NULL,
	`content_hash` text NOT NULL,
	`built_from_commit` text,
	`estimate` text,
	`how` text,
	`checked` text,
	`gaps` text,
	`created_by` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "packets_state" CHECK("state" IN ('open', 'decided', 'withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packets_item_round` ON `packets` (`item_id`,`round`);--> statement-breakpoint
CREATE UNIQUE INDEX `packets_one_open` ON `packets` (`item_id`) WHERE "state" = 'open';--> statement-breakpoint
CREATE TABLE `plan_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`reason` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_versions_item_version` ON `plan_versions` (`item_id`,`version_no`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`short_name` text NOT NULL,
	`color` text NOT NULL,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`default_satisfied_when` text DEFAULT 'done' NOT NULL,
	`deleted_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "projects_key_format" CHECK(length("key") BETWEEN 2 AND 5 AND "key" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "projects_default_satisfied_when" CHECK("default_satisfied_when" IN ('done', 'merged', 'verified')),
	CONSTRAINT "projects_next_seq" CHECK("next_seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_key_unique` ON `projects` (`key`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`run_id` text,
	`text` text NOT NULL,
	`asked_by` text NOT NULL,
	`answer` text,
	`answered_at` text,
	`read_by_agent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "questions_text" CHECK(length("text") BETWEEN 1 AND 2000),
	CONSTRAINT "questions_answer" CHECK(length("answer") <= 4000)
);
--> statement-breakpoint
CREATE INDEX `questions_item` ON `questions` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `questions_one_open` ON `questions` (`item_id`) WHERE "answered_at" IS NULL;--> statement-breakpoint
CREATE TABLE `review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`packet_id` text NOT NULL,
	`hr_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`into` text,
	`follow` text,
	`result_ref` text,
	`decided_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`packet_id`) REFERENCES `packets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hr_item_id`) REFERENCES `hr_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_decisions_kind" CHECK("kind" IN ('approve', 'changes', 'defer')),
	CONSTRAINT "review_decisions_into" CHECK("into" IN ('checklist', 'bug')),
	CONSTRAINT "review_decisions_follow" CHECK("follow" IN ('ticket', 'none')),
	CONSTRAINT "review_decisions_changes_note" CHECK("kind" <> 'changes' OR length(trim("note")) > 0),
	CONSTRAINT "review_decisions_note" CHECK(length("note") <= 4000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_decisions_packet_hr` ON `review_decisions` (`packet_id`,`hr_item_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`parent_run_id` text,
	`client` text NOT NULL,
	`label` text,
	`session_id` text,
	`is_lead` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`last_signal_at` text NOT NULL,
	`last_signal_kind` text NOT NULL,
	`lease_expires_at` text,
	`summary` text,
	`error` text,
	`current_step_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`current_step_id`) REFERENCES `work_steps`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "runs_state" CHECK("state" IN ('open', 'needs_input', 'finished', 'failed', 'interrupted')),
	CONSTRAINT "runs_last_signal_kind" CHECK("last_signal_kind" IN ('session', 'report', 'relayed'))
);
--> statement-breakpoint
CREATE INDEX `runs_item` ON `runs` (`item_id`);--> statement-breakpoint
CREATE INDEX `runs_state` ON `runs` (`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_lead` ON `runs` (`item_id`) WHERE "is_lead" = 1 AND "state" IN ('open', 'needs_input');--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subagent_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`work_step_id` text,
	`name` text NOT NULL,
	`outcome` text NOT NULL,
	`evidence` text,
	`provenance` text NOT NULL,
	`child_run_id` text,
	`reported_by_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_step_id`) REFERENCES `work_steps`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`child_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reported_by_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "subagent_logs_name" CHECK(length("name") BETWEEN 1 AND 60),
	CONSTRAINT "subagent_logs_outcome" CHECK(length("outcome") BETWEEN 1 AND 500),
	CONSTRAINT "subagent_logs_provenance" CHECK("provenance" IN ('observed', 'relayed'))
);
--> statement-breakpoint
CREATE INDEX `subagent_logs_item` ON `subagent_logs` (`item_id`);--> statement-breakpoint
CREATE TABLE `work_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`plan_version_no` integer NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`state` text DEFAULT 'todo' NOT NULL,
	`was_text` text,
	`change_reason` text,
	`from_review` text,
	`added_by` text NOT NULL,
	`state_by` text,
	`state_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_steps_text" CHECK(length("text") BETWEEN 1 AND 500),
	CONSTRAINT "work_steps_state" CHECK("state" IN ('todo', 'current', 'done', 'blocked', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `work_steps_item` ON `work_steps` (`item_id`,`plan_version_no`,`position`);