-- Onboarding (owner decision 31; BUILD_SPEC §4, §5.20): onboarding sessions,
-- started by an agent's onboard_project, finished by finish_onboarding and
-- marked reviewed by the owner, and who created a project. Additive only: one
-- new table, and one nullable column on projects (null: the owner, the seed or
-- a Jira import created it). One session in progress per project.
CREATE TABLE `onboarding_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`started_by` text NOT NULL,
	`client` text NOT NULL,
	`run_id` text,
	`started_at` text NOT NULL,
	`state` text DEFAULT 'in_progress' NOT NULL,
	`summary` text,
	`questions` text DEFAULT '[]' NOT NULL,
	`finished_at` text,
	`reviewed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "onboarding_sessions_state" CHECK("state" IN ('in_progress', 'ready_for_review', 'reviewed')),
	CONSTRAINT "onboarding_sessions_summary" CHECK(CASE WHEN "state" = 'in_progress' THEN "summary" IS NULL ELSE "summary" IS NOT NULL AND length("summary") BETWEEN 1 AND 4000 END),
	CONSTRAINT "onboarding_sessions_questions" CHECK(json_valid("questions") AND json_type("questions") = 'array' AND json_array_length("questions") <= 20),
	CONSTRAINT "onboarding_sessions_finished" CHECK(("state" = 'in_progress') = ("finished_at" IS NULL)),
	CONSTRAINT "onboarding_sessions_reviewed" CHECK(("state" = 'reviewed') = ("reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_sessions_one_in_progress` ON `onboarding_sessions` (`project_key`) WHERE "state" = 'in_progress';--> statement-breakpoint
CREATE INDEX `onboarding_sessions_project_state` ON `onboarding_sessions` (`project_key`,`state`);--> statement-breakpoint
ALTER TABLE `projects` ADD `created_by` text;