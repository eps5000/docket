-- Overlaps reach the owner only when they need the owner (owner decision 39; BUILD_SPEC §5.21; B46).
-- Additive and forward-only: nullable or defaulted columns, no table rebuild. Existing declarations
-- read as bare parts, every decided overlap stays decided, and existing projects follow the default.
ALTER TABLE `item_shared_changes` ADD `member` text;--> statement-breakpoint
ALTER TABLE `item_shared_changes` ADD `design_impact` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `item_shared_changes` ADD `design_note` text;--> statement-breakpoint
ALTER TABLE `item_shared_changes` ADD `disputed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `part_overlaps` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `part_overlaps` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `part_overlaps` ADD `evidence` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `overlap_handling` text;--> statement-breakpoint
ALTER TABLE `radar_findings` ADD `merge_first` text;