ALTER TABLE `installs` ADD `removed_at` text;--> statement-breakpoint
ALTER TABLE `installs` ADD `removal` text;--> statement-breakpoint
ALTER TABLE `installs` ADD `removal_token_sha256` text;--> statement-breakpoint
ALTER TABLE `installs` ADD `removal_token_expires_at` text;--> statement-breakpoint
ALTER TABLE `installs` ADD `removal_token_used_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `installs_removal_token` ON `installs` (`removal_token_sha256`) WHERE "removal_token_sha256" IS NOT NULL;