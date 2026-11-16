-- Recovery (owner decision 26; BUILD_SPEC §4, §5.16): run workspaces, briefs,
-- parking, end reasons and resources; `commits.run_id`/`pushed`; the `brief`
-- document kind.
--
-- `runs` and `documents` are rebuilt (SQLite can't alter a CHECK constraint):
-- `runs.state` gains `parked`, and the one-active-lead index now counts a
-- parked run, which keeps its claim. Drizzle runs every migration inside one
-- transaction, where `PRAGMA foreign_keys` is a no-op, so `migrateDb` turns
-- foreign keys off around the whole run and then checks
-- `PRAGMA foreign_key_check` (the SQLite table-rebuild procedure). Without
-- that, `DROP TABLE runs` would fire the children's ON DELETE actions.
-- Every new column is nullable or defaulted, so existing rows carry over.
CREATE TABLE `run_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`locator` text NOT NULL,
	`started_at` text NOT NULL,
	`released_at` text,
	`released_by` text,
	`release_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_resources_kind" CHECK("kind" IN ('process', 'dev_server', 'session', 'container', 'temp_dir', 'port', 'other')),
	CONSTRAINT "run_resources_label" CHECK(length("label") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE INDEX `run_resources_run` ON `run_resources` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_resources_unreleased` ON `run_resources` (`released_at`);--> statement-breakpoint
CREATE TABLE `__new_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`item_id` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "documents_kind" CHECK("kind" IN ('planning', 'packet_attachment', 'import_report', 'brief', 'other'))
);
--> statement-breakpoint
INSERT INTO `__new_documents`("id", "project_key", "item_id", "name", "kind", "created_at", "updated_at") SELECT "id", "project_key", "item_id", "name", "kind", "created_at", "updated_at" FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
CREATE UNIQUE INDEX `documents_item_name` ON `documents` (`item_id`,`name`);--> statement-breakpoint
CREATE INDEX `documents_project` ON `documents` (`project_key`);--> statement-breakpoint
CREATE TABLE `__new_runs` (
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
	`end_reason` text,
	`parked_reason` text,
	`waiting_on` text,
	`parked_at` text,
	`workspace` text,
	`orchestrator` text,
	`brief_document_version_id` text,
	`external` text,
	`unpushed_handled_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`current_step_id`) REFERENCES `work_steps`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`brief_document_version_id`) REFERENCES `document_versions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "runs_state" CHECK("state" IN ('open', 'needs_input', 'parked', 'finished', 'failed', 'interrupted')),
	CONSTRAINT "runs_last_signal_kind" CHECK("last_signal_kind" IN ('session', 'report', 'relayed')),
	CONSTRAINT "runs_end_reason" CHECK("end_reason" IS NULL OR "end_reason" IN ('finished', 'failed', 'released', 'lease_expired', 'owner_released', 'service_restart', 'canceled')),
	CONSTRAINT "runs_external" CHECK("external" IS NULL OR length(CAST("external" AS BLOB)) <= 2048)
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "item_id", "parent_run_id", "client", "label", "session_id", "is_lead", "state", "last_signal_at", "last_signal_kind", "lease_expires_at", "summary", "error", "current_step_id", "version", "created_at", "updated_at") SELECT "id", "item_id", "parent_run_id", "client", "label", "session_id", "is_lead", "state", "last_signal_at", "last_signal_kind", "lease_expires_at", "summary", "error", "current_step_id", "version", "created_at", "updated_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE INDEX `runs_item` ON `runs` (`item_id`);--> statement-breakpoint
CREATE INDEX `runs_state` ON `runs` (`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_lead` ON `runs` (`item_id`) WHERE "is_lead" = 1 AND "state" IN ('open', 'needs_input', 'parked');--> statement-breakpoint
ALTER TABLE `commits` ADD `run_id` text REFERENCES runs(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `commits` ADD `pushed` integer DEFAULT false NOT NULL;
