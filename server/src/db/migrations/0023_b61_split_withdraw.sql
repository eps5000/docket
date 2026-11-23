DROP INDEX `questions_one_open`;--> statement-breakpoint
ALTER TABLE `questions` ADD `withdrawn_at` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `withdrawn_by` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `withdrawn_reason` text;--> statement-breakpoint
CREATE UNIQUE INDEX `questions_one_open` ON `questions` (`item_id`) WHERE "answered_at" IS NULL AND "withdrawn_at" IS NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `split_from` text REFERENCES items(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `items_split_from` ON `items` (`split_from`);--> statement-breakpoint
ALTER TABLE `packets` ADD `criteria_changed_at` text;