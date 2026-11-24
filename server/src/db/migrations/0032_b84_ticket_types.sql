-- Ticket types by kind of work (owner decision 67; BUILD_SPEC §5.47; B84).
-- `items.type` allows Epic, Exploration, Design, Implementation, Bug and Release.
-- Story and Task become Implementation, marked inferred with the old type kept
-- (`type_info` = {"inferred": true, "original": "Story"}). New columns:
-- `type_info`, `rollout` (decision 67's rollout marker) and `findings_md`
-- (an Exploration's findings). `finish_line` stays for the Release migration
-- (domain/release-migration.ts), which converts or generates each open epic's
-- Release after this runs.
--
-- `items` is rebuilt (SQLite can't alter a CHECK constraint), every row copied,
-- so every reference by ID stays attached. As for 0007, `migrateDb` turns
-- foreign keys off around the run and checks `PRAGMA foreign_key_check`
-- afterwards. Dropping the table drops its triggers, so 0001's search triggers
-- and 0018's producer-hold trigger are created again, unchanged; the search
-- index rows are matched by ID and stay as they are.
CREATE TABLE `__new_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description_md` text DEFAULT '' NOT NULL,
	`outcome_md` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 2 NOT NULL,
	`epic_id` text,
	`planned_start` text,
	`planned_end` text,
	`dates_set_by` text,
	`dates_set_at` text,
	`effort` real,
	`effort_unit` text DEFAULT 'pts' NOT NULL,
	`closed_by` text,
	`closed_at` text,
	`archived_at` text,
	`jira_key` text,
	`imported` integer DEFAULT false NOT NULL,
	`from_review` text,
	`shared_none_at` text,
	`branch` text,
	`branch_by` text,
	`branch_at` text,
	`radar_branch` text,
	`radar_branch_matches` text,
	`branches` text,
	`split_from` text,
	`known_gaps` text,
	`finish_line` text,
	`type_info` text,
	`rollout` integer DEFAULT false NOT NULL,
	`findings_md` text,
	`shaping` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epic_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`split_from`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "items_type" CHECK("type" IN ('Epic', 'Exploration', 'Design', 'Implementation', 'Bug', 'Release')),
	CONSTRAINT "items_status" CHECK("status" IN ('inbox', 'planning', 'ready', 'progress', 'review', 'done', 'canceled')),
	CONSTRAINT "items_priority" CHECK("priority" BETWEEN 1 AND 3),
	CONSTRAINT "items_title" CHECK(length("title") BETWEEN 1 AND 200),
	CONSTRAINT "items_description_md" CHECK(length("description_md") <= 20000),
	CONSTRAINT "items_outcome_md" CHECK(length("outcome_md") <= 20000),
	CONSTRAINT "items_effort" CHECK("effort" >= 0),
	CONSTRAINT "items_closed_by" CHECK("closed_by" IN ('owner', 'agent', 'imported')),
	CONSTRAINT "items_epic_not_self" CHECK("epic_id" <> "id"),
	CONSTRAINT "items_findings_md" CHECK(length("findings_md") <= 20000)
);
--> statement-breakpoint
INSERT INTO `__new_items`("id", "project_key", "type", "title", "description_md", "outcome_md", "status", "priority", "epic_id", "planned_start", "planned_end", "dates_set_by", "dates_set_at", "effort", "effort_unit", "closed_by", "closed_at", "archived_at", "jira_key", "imported", "from_review", "shared_none_at", "branch", "branch_by", "branch_at", "radar_branch", "radar_branch_matches", "branches", "split_from", "known_gaps", "finish_line", "type_info", "rollout", "findings_md", "shaping", "version", "created_at", "updated_at") SELECT "id", "project_key", CASE WHEN "type" IN ('Story', 'Task') THEN 'Implementation' ELSE "type" END, "title", "description_md", "outcome_md", "status", "priority", "epic_id", "planned_start", "planned_end", "dates_set_by", "dates_set_at", "effort", "effort_unit", "closed_by", "closed_at", "archived_at", "jira_key", "imported", "from_review", "shared_none_at", "branch", "branch_by", "branch_at", "radar_branch", "radar_branch_matches", "branches", "split_from", "known_gaps", "finish_line", CASE WHEN "type" IN ('Story', 'Task') THEN json_object('inferred', json('true'), 'original', "type") ELSE NULL END, 0, NULL, "shaping", "version", "created_at", "updated_at" FROM `items`;--> statement-breakpoint
DROP TABLE `items`;--> statement-breakpoint
ALTER TABLE `__new_items` RENAME TO `items`;--> statement-breakpoint
CREATE INDEX `items_project_status` ON `items` (`project_key`,`status`);--> statement-breakpoint
CREATE INDEX `items_split_from` ON `items` (`split_from`);--> statement-breakpoint
CREATE INDEX `items_epic` ON `items` (`epic_id`);--> statement-breakpoint
CREATE TRIGGER `search_fts_items_insert` AFTER INSERT ON `items` BEGIN
	INSERT INTO search_fts (id, title, description_md, outcome_md, labels, jira_key)
	VALUES (
		new.id, new.title, new.description_md, new.outcome_md,
		coalesce((SELECT group_concat(name, ' ') FROM (
			SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id
			WHERE il.item_id = new.id ORDER BY l.name)), ''),
		coalesce(new.jira_key, '')
	);
END;
--> statement-breakpoint
CREATE TRIGGER `search_fts_items_update` AFTER UPDATE OF id, title, description_md, outcome_md, jira_key ON `items` BEGIN
	DELETE FROM search_fts WHERE id = old.id;
	INSERT INTO search_fts (id, title, description_md, outcome_md, labels, jira_key)
	VALUES (
		new.id, new.title, new.description_md, new.outcome_md,
		coalesce((SELECT group_concat(name, ' ') FROM (
			SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id
			WHERE il.item_id = new.id ORDER BY l.name)), ''),
		coalesce(new.jira_key, '')
	);
END;
--> statement-breakpoint
CREATE TRIGGER `search_fts_items_delete` AFTER DELETE ON `items` BEGIN
	DELETE FROM search_fts WHERE id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `items_status_ends_producer_hold` AFTER UPDATE OF `status` ON `items`
WHEN NEW.`status` <> 'progress'
BEGIN
  UPDATE `runs` SET `producer_hold_until` = NULL
  WHERE `item_id` = NEW.`id` AND `producer_hold_until` IS NOT NULL;
END;
