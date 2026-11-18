-- Agent proposals and drift (owner decision 30; BUILD_SPEC §4, §5.19): agents'
-- proposed changes to agent files and Workflow notes, instruction reports (from
-- claim_lead and the scheduled push-folder check), and drift records. Additive
-- only: three new tables, no existing table changes. drift carries two columns
-- BUILD_SPEC §4 gained in B26 (change, report_id), and one open row per install
-- and file (B26 resolution 7).
CREATE TABLE `agent_file_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text,
	`file_key` text NOT NULL,
	`content` text NOT NULL,
	`reason` text NOT NULL,
	`based_on_version_id` text,
	`run_id` text,
	`proposed_by` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`decided_at` text,
	`decided_note` text,
	`result_version_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_file_proposals_state" CHECK("state" IN ('pending', 'approved', 'declined')),
	CONSTRAINT "agent_file_proposals_file_key" CHECK("file_key" = 'workflow' OR ("file_key" = 'agents_block' OR ("file_key" GLOB 'skill:?*' AND length("file_key") <= 66 AND substr("file_key", 7) NOT GLOB '*[^a-z0-9-]*'))),
	CONSTRAINT "agent_file_proposals_workflow_project" CHECK("file_key" <> 'workflow' OR "project_key" IS NOT NULL),
	CONSTRAINT "agent_file_proposals_content" CHECK(CASE WHEN "file_key" = 'workflow' THEN length("content") <= 10000 ELSE length("content") BETWEEN 1 AND 50000 END),
	CONSTRAINT "agent_file_proposals_reason" CHECK(length("reason") BETWEEN 1 AND 500),
	CONSTRAINT "agent_file_proposals_decided_note" CHECK("decided_note" IS NULL OR length("decided_note") <= 500),
	CONSTRAINT "agent_file_proposals_decided" CHECK(("state" = 'pending') = ("decided_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `agent_file_proposals_target` ON `agent_file_proposals` (`project_key`,`file_key`,`state`);--> statement-breakpoint
CREATE INDEX `agent_file_proposals_run` ON `agent_file_proposals` (`run_id`);--> statement-breakpoint
CREATE TABLE `drift` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`project_key` text,
	`file_key` text NOT NULL,
	`change` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`local_sha256` text,
	`report_id` text,
	`detected_at` text NOT NULL,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`report_id`) REFERENCES `instruction_reports`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "drift_state" CHECK("state" IN ('open', 'adopted', 'restored', 'kept_local')),
	CONSTRAINT "drift_change" CHECK("change" IN ('edited', 'missing', 'extra')),
	CONSTRAINT "drift_file_key" CHECK("file_key" = 'agents_block' OR ("file_key" GLOB 'skill:?*' AND length("file_key") <= 66 AND substr("file_key", 7) NOT GLOB '*[^a-z0-9-]*')),
	CONSTRAINT "drift_local_sha256" CHECK(CASE WHEN "change" = 'missing' THEN "local_sha256" IS NULL ELSE "local_sha256" IS NOT NULL AND length("local_sha256") = 64 END),
	CONSTRAINT "drift_resolved" CHECK(("state" = 'open') = ("resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drift_open_install_file` ON `drift` (`install_id`,`file_key`) WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX `drift_project_state` ON `drift` (`project_key`,`state`);--> statement-breakpoint
CREATE TABLE `instruction_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`run_id` text,
	`install_id` text,
	`project_key` text,
	`location` text,
	`files` text NOT NULL,
	`at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "instruction_reports_source" CHECK("source" IN ('agent', 'push_check')),
	CONSTRAINT "instruction_reports_agent_run" CHECK("source" <> 'agent' OR "run_id" IS NOT NULL),
	CONSTRAINT "instruction_reports_location" CHECK("location" IS NULL OR length("location") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE INDEX `instruction_reports_run` ON `instruction_reports` (`run_id`);--> statement-breakpoint
CREATE INDEX `instruction_reports_install` ON `instruction_reports` (`install_id`,`at`);