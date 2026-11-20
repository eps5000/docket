-- Problems that say what to do (owner decision 37; BUILD_SPEC §5.22 Problems, §5.21 B42). Additive:
-- two new tables, the owner's acknowledgements of problems and agents' proposed resolutions. No
-- existing table is changed.
CREATE TABLE `problem_acks` (
	`id` text PRIMARY KEY NOT NULL,
	`problem_id` text NOT NULL,
	`project_key` text,
	`item_id` text,
	`kind` text NOT NULL,
	`branches` text NOT NULL,
	`facts` text NOT NULL,
	`acked_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "problem_acks_problem_id" CHECK(length("problem_id") BETWEEN 1 AND 300),
	CONSTRAINT "problem_acks_branches" CHECK(json_valid("branches") AND json_type("branches") = 'array'),
	CONSTRAINT "problem_acks_facts" CHECK(json_valid("facts") AND json_type("facts") = 'array')
);
--> statement-breakpoint
CREATE INDEX `problem_acks_problem` ON `problem_acks` (`problem_id`);--> statement-breakpoint
CREATE TABLE `resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`problem_id` text,
	`problem_kind` text,
	`kind` text NOT NULL,
	`plan_md` text NOT NULL,
	`reason` text NOT NULL,
	`proposed_by` text NOT NULL,
	`run_id` text,
	`state` text DEFAULT 'open' NOT NULL,
	`note` text,
	`decided_by` text,
	`decided_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "resolutions_kind" CHECK("kind" IN ('split', 'rescope', 'reorder', 'other')),
	CONSTRAINT "resolutions_state" CHECK("state" IN ('open', 'approved', 'different', 'acknowledged', 'superseded')),
	CONSTRAINT "resolutions_plan" CHECK(length("plan_md") BETWEEN 1 AND 10000),
	CONSTRAINT "resolutions_reason" CHECK(length("reason") BETWEEN 1 AND 1000),
	CONSTRAINT "resolutions_note" CHECK(length("note") <= 1000),
	CONSTRAINT "resolutions_decided" CHECK(("state" IN ('open', 'superseded')) = ("decided_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `resolutions_item` ON `resolutions` (`item_id`);--> statement-breakpoint
CREATE INDEX `resolutions_open` ON `resolutions` (`state`);