-- The radar sees in-flight branches (decision 36; BUILD_SPEC §5.21 B40). Additive and forward-only:
-- nullable columns on items (the reported branch: branch, branch_by, branch_at; what the radar
-- found: radar_branch, radar_branch_matches) and on radar_findings (source_a, source_b: reported
-- or discovered). No table is rebuilt and no existing row changes.
ALTER TABLE `items` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `items` ADD `branch_by` text;--> statement-breakpoint
ALTER TABLE `items` ADD `branch_at` text;--> statement-breakpoint
ALTER TABLE `items` ADD `radar_branch` text;--> statement-breakpoint
ALTER TABLE `items` ADD `radar_branch_matches` text;--> statement-breakpoint
ALTER TABLE `radar_findings` ADD `source_a` text;--> statement-breakpoint
ALTER TABLE `radar_findings` ADD `source_b` text;