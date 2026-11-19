-- Step details (owner decision 33; BUILD_SPEC §4, §5.5; B33): a checklist step can carry
-- Markdown details and a source (for example a Jira key), and a details_version that the
-- owner's step dialog checks. Additive and forward-only: three columns on work_steps, the
-- first two nullable and the third defaulting to 0, so existing steps read as having no
-- details. Limits (details ≤ 10,000, source ≤ 100) are checked by the tool and route
-- schemas, so the table is not rebuilt.
ALTER TABLE `work_steps` ADD `details_md` text;--> statement-breakpoint
ALTER TABLE `work_steps` ADD `source` text;--> statement-breakpoint
ALTER TABLE `work_steps` ADD `details_version` integer DEFAULT 0 NOT NULL;