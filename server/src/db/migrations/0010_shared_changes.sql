-- Shared changes and conflict guardrails (owner decision 36; BUILD_SPEC §4, §5.21; B38).
-- Additive and forward-only: six new tables (the shared-part registry, item declarations,
-- overlaps, leases, undeclared-parts holds and radar findings) and nullable or defaulted
-- columns on items (shared_none_at), packets (changed_files, branch, held_undeclared) and
-- projects (repo_path, main_branch, radar_last_run_at, radar_off_reason). No existing table
-- is rebuilt and no existing row changes: items read as not declared, packets as not
-- reporting changed files, and projects with the radar off on branch main.
CREATE TABLE `item_shared_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`part_key` text NOT NULL,
	`change` text NOT NULL,
	`note` text,
	`declared_by` text NOT NULL,
	`declared_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "item_shared_changes_change" CHECK("change" IN ('add', 'change', 'remove')),
	CONSTRAINT "item_shared_changes_note" CHECK(length("note") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_shared_changes_item_part` ON `item_shared_changes` (`item_id`,`part_key`);--> statement-breakpoint
CREATE INDEX `item_shared_changes_part` ON `item_shared_changes` (`part_key`);--> statement-breakpoint
CREATE TABLE `part_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`part_key` text NOT NULL,
	`item_id` text NOT NULL,
	`run_id` text,
	`taken_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`ended_at` text,
	`end_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "part_leases_end_reason" CHECK("end_reason" IS NULL OR "end_reason" IN ('released', 'owner_released', 'done', 'handed_off', 'expired')),
	CONSTRAINT "part_leases_ended" CHECK(("ended_at" IS NULL) = ("end_reason" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `part_leases_one_live` ON `part_leases` (`project_key`,`part_key`) WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `part_leases_item` ON `part_leases` (`item_id`);--> statement-breakpoint
CREATE TABLE `part_overlaps` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`item_a` text NOT NULL,
	`item_b` text NOT NULL,
	`claimed_first` text NOT NULL,
	`parts` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`note` text,
	`link_id` text,
	`raised_at` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_a`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_b`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "part_overlaps_order" CHECK("item_a" < "item_b"),
	CONSTRAINT "part_overlaps_first" CHECK("claimed_first" IN ("item_a", "item_b")),
	CONSTRAINT "part_overlaps_state" CHECK("state" IN ('open', 'sequenced', 'compatible', 'resolved')),
	CONSTRAINT "part_overlaps_parts" CHECK(json_valid("parts") AND json_type("parts") = 'array'),
	CONSTRAINT "part_overlaps_note" CHECK(length("note") <= 1000),
	CONSTRAINT "part_overlaps_decided" CHECK(("state" IN ('sequenced', 'compatible')) <= ("decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `part_overlaps_live_pair` ON `part_overlaps` (`item_a`,`item_b`) WHERE "state" <> 'resolved';--> statement-breakpoint
CREATE INDEX `part_overlaps_project_state` ON `part_overlaps` (`project_key`,`state`);--> statement-breakpoint
CREATE INDEX `part_overlaps_item_b` ON `part_overlaps` (`item_b`);--> statement-breakpoint
CREATE TABLE `radar_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`branch_a` text NOT NULL,
	`branch_b` text NOT NULL,
	`item_a` text,
	`item_b` text,
	`files` text NOT NULL,
	`seen_at` text NOT NULL,
	`cleared_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_a`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_b`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "radar_findings_files" CHECK(json_valid("files") AND json_type("files") = 'array'),
	CONSTRAINT "radar_findings_branches" CHECK("branch_a" <> "branch_b")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `radar_findings_open_pair` ON `radar_findings` (`project_key`,`branch_a`,`branch_b`) WHERE "cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX `radar_findings_item_a` ON `radar_findings` (`item_a`);--> statement-breakpoint
CREATE INDEX `radar_findings_item_b` ON `radar_findings` (`item_b`);--> statement-breakpoint
CREATE TABLE `shared_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`paths` text DEFAULT '[]' NOT NULL,
	`single_writer` integer DEFAULT false NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "shared_parts_kind" CHECK("kind" IN ('table', 'model', 'endpoint', 'file', 'other')),
	CONSTRAINT "shared_parts_key" CHECK(length("key") BETWEEN 3 AND 200 AND substr("key", 1, length("kind") + 1) = "kind" || ':' AND length("key") > length("kind") + 1),
	CONSTRAINT "shared_parts_paths" CHECK(json_valid("paths") AND json_type("paths") = 'array' AND json_array_length("paths") <= 20),
	CONSTRAINT "shared_parts_note" CHECK(length("note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_parts_project_key` ON `shared_parts` (`project_key`,`key`);--> statement-breakpoint
CREATE TABLE `undeclared_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`packet_id` text,
	`via` text NOT NULL,
	`parts` text NOT NULL,
	`files` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`note` text,
	`decided_by` text,
	`decided_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`packet_id`) REFERENCES `packets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "undeclared_holds_via" CHECK("via" IN ('submit_packet', 'set_status')),
	CONSTRAINT "undeclared_holds_state" CHECK("state" IN ('open', 'added', 'sent_back')),
	CONSTRAINT "undeclared_holds_parts" CHECK(json_valid("parts") AND json_type("parts") = 'array'),
	CONSTRAINT "undeclared_holds_files" CHECK(json_valid("files") AND json_type("files") = 'array' AND json_array_length("files") <= 2000),
	CONSTRAINT "undeclared_holds_note" CHECK(length("note") <= 1000),
	CONSTRAINT "undeclared_holds_decided" CHECK(("state" = 'open') = ("decided_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `undeclared_holds_one_open` ON `undeclared_holds` (`item_id`) WHERE "state" = 'open';--> statement-breakpoint
ALTER TABLE `items` ADD `shared_none_at` text;--> statement-breakpoint
ALTER TABLE `packets` ADD `changed_files` text;--> statement-breakpoint
ALTER TABLE `packets` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `packets` ADD `held_undeclared` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `repo_path` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `main_branch` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `radar_last_run_at` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `radar_off_reason` text;