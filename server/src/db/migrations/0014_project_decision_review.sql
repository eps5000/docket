-- Project decisions get their own page (owner decision 38; BUILD_SPEC §4, §5.14; B44). Additive
-- and forward-only: two columns on decision_records. `acknowledged_at` records the owner's
-- *Acknowledge* on Needs you (the record stays an agent decision). `review_grouped` marks the agent
-- project records that predate the review card, which Needs you shows once as one grouped card
-- rather than one card each; it is set here for every active agent project record.
ALTER TABLE `decision_records` ADD `acknowledged_at` text;--> statement-breakpoint
ALTER TABLE `decision_records` ADD `review_grouped` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `decision_records` SET `review_grouped` = 1 WHERE `scope_kind` = 'project' AND `authority` = 'agent' AND `status` = 'active';