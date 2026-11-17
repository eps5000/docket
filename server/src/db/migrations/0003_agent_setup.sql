-- Agent setup (owner decision 29; BUILD_SPEC §4, §5.17): agent files in three
-- layers (bundled, service-wide edit, project override) with immutable
-- versions, each project's versioned Workflow notes, and the install log.
-- Additive only: four new tables, no existing table changes. installs keeps
-- the sha256 of a command install's single-use download token and its expiry
-- (B21 resolution), never the token itself.
CREATE TABLE `agent_file_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`content` text NOT NULL,
	`sha256` text NOT NULL,
	`author` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `agent_files`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_file_versions_version_no" CHECK("version_no" >= 1),
	CONSTRAINT "agent_file_versions_content" CHECK(length("content") BETWEEN 1 AND 50000),
	CONSTRAINT "agent_file_versions_sha256" CHECK(length("sha256") = 64),
	CONSTRAINT "agent_file_versions_note" CHECK("note" IS NULL OR length("note") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_file_versions_file_version` ON `agent_file_versions` (`file_id`,`version_no`);--> statement-breakpoint
CREATE TABLE `agent_files` (
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
	CONSTRAINT "agent_files_key" CHECK("key" = 'agents_block' OR ("key" GLOB 'skill:?*' AND length("key") <= 66 AND substr("key", 7) NOT GLOB '*[^a-z0-9-]*'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_files_key_layer` ON `agent_files` (`key`,`layer`) WHERE "project_key" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_files_key_project` ON `agent_files` (`key`,`project_key`) WHERE "project_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_files_project` ON `agent_files` (`project_key`);--> statement-breakpoint
CREATE TABLE `installs` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`client` text NOT NULL,
	`target_kind` text NOT NULL,
	`project_key` text,
	`path` text,
	`method` text NOT NULL,
	`manifest` text NOT NULL,
	`token_sha256` text,
	`token_expires_at` text,
	`token_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "installs_client" CHECK("client" IN ('claude', 'codex')),
	CONSTRAINT "installs_target_kind" CHECK("target_kind" IN ('repo', 'user')),
	CONSTRAINT "installs_method" CHECK("method" IN ('command', 'push')),
	CONSTRAINT "installs_path" CHECK("path" IS NULL OR length("path") BETWEEN 1 AND 1000),
	CONSTRAINT "installs_token" CHECK(("token_sha256" IS NULL) = ("token_expires_at" IS NULL) AND ("method" = 'command' OR "token_sha256" IS NULL)),
	CONSTRAINT "installs_push_path" CHECK("method" = 'command' OR "path" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `installs_at` ON `installs` (`at`);--> statement-breakpoint
CREATE INDEX `installs_project` ON `installs` (`project_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `installs_token` ON `installs` (`token_sha256`) WHERE "token_sha256" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `project_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`version_no` integer NOT NULL,
	`content_md` text NOT NULL,
	`author` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_workflows_version_no" CHECK("version_no" >= 1),
	CONSTRAINT "project_workflows_content_md" CHECK(length("content_md") <= 10000),
	CONSTRAINT "project_workflows_note" CHECK("note" IS NULL OR length("note") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_workflows_project_version` ON `project_workflows` (`project_key`,`version_no`);