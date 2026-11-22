-- Status that follows the work (owner decision 42; BUILD_SPEC §5.23; B50). Additive: new nullable
-- columns, no rebuild, and every existing run reads as having no producer, update or activity.
-- The trigger ends a producer's hold whichever path moves the item out of In progress, so a story
-- sent back from Review later is plainly resumable rather than held by an old handoff.
ALTER TABLE `projects` ADD `coordinators` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `producer` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `producer_hold_until` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `status_update` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `park_activity` text;--> statement-breakpoint
CREATE TRIGGER `items_status_ends_producer_hold` AFTER UPDATE OF `status` ON `items`
WHEN NEW.`status` <> 'progress'
BEGIN
  UPDATE `runs` SET `producer_hold_until` = NULL
  WHERE `item_id` = NEW.`id` AND `producer_hold_until` IS NOT NULL;
END;
