-- The onboarding guide as an agent file (owner decision 31; BUILD_SPEC §4,
-- §5.20; B30 contract change): `agent_files.key` also allows exactly
-- `guide:onboarding`. Nothing else changes: agent_file_proposals keeps its
-- narrower key check (the guide can't be proposed), and installs never carry it.
--
-- `agent_files` is rebuilt (SQLite can't alter a CHECK constraint), with every
-- row copied unchanged, so `agent_file_versions` and the history stay attached
-- by ID. As for 0002, `migrateDb` turns foreign keys off around the run and
-- checks `PRAGMA foreign_key_check` afterwards (SQLite's table-rebuild procedure).
CREATE TABLE `__new_agent_files` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`layer` text NOT NULL,
	`project_key` text,
	`current_version_id` text,
	`bundled_hash_at_edit` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`current_version_id`) REFERENCES `agent_file_versions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_files_layer" CHECK("layer" IN ('bundled', 'service', 'project')),
	CONSTRAINT "agent_files_project_layer" CHECK(("layer" = 'project') = ("project_key" IS NOT NULL)),
	CONSTRAINT "agent_files_key" CHECK("key" = 'agents_block' OR "key" = 'guide:onboarding' OR ("key" GLOB 'skill:?*' AND length("key") <= 66 AND substr("key", 7) NOT GLOB '*[^a-z0-9-]*'))
);
--> statement-breakpoint
INSERT INTO `__new_agent_files`("id", "key", "layer", "project_key", "current_version_id", "bundled_hash_at_edit", "created_at", "updated_at") SELECT "id", "key", "layer", "project_key", "current_version_id", "bundled_hash_at_edit", "created_at", "updated_at" FROM `agent_files`;--> statement-breakpoint
DROP TABLE `agent_files`;--> statement-breakpoint
ALTER TABLE `__new_agent_files` RENAME TO `agent_files`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_files_key_layer` ON `agent_files` (`key`,`layer`) WHERE "project_key" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_files_key_project` ON `agent_files` (`key`,`project_key`) WHERE "project_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_files_project` ON `agent_files` (`project_key`);
