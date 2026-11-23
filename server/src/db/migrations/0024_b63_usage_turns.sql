CREATE TABLE `usage_turns` (
	`key` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`item_id` text,
	`link` text NOT NULL,
	`client` text NOT NULL,
	`session_id` text NOT NULL,
	`at` text NOT NULL,
	`workspace` text NOT NULL,
	`model` text,
	`fresh_input` integer DEFAULT 0 NOT NULL,
	`cached_input` integer DEFAULT 0 NOT NULL,
	`cache_write` integer DEFAULT 0 NOT NULL,
	`cache_write_1h` integer DEFAULT 0 NOT NULL,
	`output` integer DEFAULT 0 NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "usage_turns_link" CHECK("link" IN ('ticket', 'overhead', 'unlinked')),
	CONSTRAINT "usage_turns_client" CHECK("client" IN ('claude-code', 'codex'))
);
--> statement-breakpoint
CREATE INDEX `usage_turns_at` ON `usage_turns` (`at`);--> statement-breakpoint
CREATE INDEX `usage_turns_project_at` ON `usage_turns` (`project_key`,`at`);--> statement-breakpoint
CREATE INDEX `usage_turns_item` ON `usage_turns` (`item_id`);--> statement-breakpoint
CREATE INDEX `usage_turns_link_at` ON `usage_turns` (`link`,`at`);--> statement-breakpoint
CREATE INDEX `usage_turns_workspace` ON `usage_turns` (`workspace`);