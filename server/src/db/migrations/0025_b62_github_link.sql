CREATE TABLE `github_pr_links` (
	`id` text PRIMARY KEY NOT NULL,
	`pr_id` text NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `github_prs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `github_pr_links_item` ON `github_pr_links` (`item_id`);--> statement-breakpoint
CREATE INDEX `github_pr_links_pr` ON `github_pr_links` (`pr_id`);--> statement-breakpoint
CREATE TABLE `github_prs` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`head_branch` text NOT NULL,
	`state` text NOT NULL,
	`draft` integer DEFAULT false NOT NULL,
	`head_sha` text,
	`merged_at` text,
	`ci` text NOT NULL,
	`opened_at` text NOT NULL,
	`remote_updated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `github_prs_repo` ON `github_prs` (`repo`);--> statement-breakpoint
CREATE INDEX `github_prs_merged` ON `github_prs` (`merged_at`);--> statement-breakpoint
CREATE TABLE `project_git` (
	`project_key` text PRIMARY KEY NOT NULL,
	`github_repo` text,
	`branch_rule` text DEFAULT 'warn' NOT NULL,
	`branch_exempt` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_git_branch_rule" CHECK("branch_rule" IN ('off', 'warn'))
);
--> statement-breakpoint
CREATE TABLE `sync_sources` (
	`name` text PRIMARY KEY NOT NULL,
	`interval_ms` integer,
	`last_report_at` text,
	`last_success_at` text,
	`last_error` text,
	`records_total` integer DEFAULT 0 NOT NULL,
	`detail` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
