-- Overlaps reach the owner only when they need the owner (owner decision 39; BUILD_SPEC §5.21; B46).
-- Additive and forward-only: new columns and one new table, no rebuild. Existing declarations read
-- as bare parts, every decided overlap stays decided, and existing projects follow the default.
-- design_reviews holds the owner review of a declared change to an approved design.
CREATE TABLE `design_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`item_id` text NOT NULL,
	`entries` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`note` text,
	`requested_by` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "design_reviews_state" CHECK("state" IN ('open', 'approved', 'sent_back', 'withdrawn')),
	CONSTRAINT "design_reviews_entries" CHECK(json_valid("entries") AND json_type("entries") = 'array'),
	CONSTRAINT "design_reviews_note" CHECK(length("note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `design_reviews_open_item` ON `design_reviews` (`item_id`) WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX `design_reviews_project_state` ON `design_reviews` (`project_key`,`state`);--> statement-breakpoint
ALTER TABLE `item_shared_changes` ADD `member` text;--> statement-breakpoint
ALTER TABLE `item_shared_changes` ADD `design_impact` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `item_shared_changes` ADD `design_note` text;--> statement-breakpoint
ALTER TABLE `item_shared_changes` ADD `disputed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `part_overlaps` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `part_overlaps` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `part_overlaps` ADD `evidence` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `overlap_handling` text;--> statement-breakpoint
ALTER TABLE `radar_findings` ADD `merge_first` text;