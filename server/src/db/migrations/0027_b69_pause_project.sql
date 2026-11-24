ALTER TABLE `decision_records` ADD `pauses_project` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `decision_records` ADD `pause_lifted_at` text;--> statement-breakpoint
CREATE INDEX `decision_records_pause` ON `decision_records` (`project_key`,`status`) WHERE "pauses_project" = 1;