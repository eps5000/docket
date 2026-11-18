-- The rename to Docket (B28; the product was formerly Task Lite): the stored agent
-- file keys `skill:tasklite-*` become `skill:docket-*`. Data only, no schema change.
-- Versions, history and IDs are kept: an agent file keeps its id, so its versions,
-- proposals and adoptions stay attached. Event payloads are history and keep the
-- names they were written with.
--
-- - agent_files.key, agent_file_proposals.file_key and drift.file_key are renamed.
--   OR IGNORE: a row whose new key already exists keeps its old one (none should).
-- - installs.manifest is JSON keyed by file key. Each old skill key is renamed and
--   gains `installed_as` (the folder it was installed in, `tasklite-worker`), so
--   checks still read the files where the install put them.
-- - instruction_reports.files is JSON keyed by file key: renamed the same way.
UPDATE OR IGNORE `agent_files`
SET `key` = 'skill:docket-' || substr(`key`, 16)
WHERE `key` GLOB 'skill:tasklite-?*';
--> statement-breakpoint
UPDATE OR IGNORE `agent_file_proposals`
SET `file_key` = 'skill:docket-' || substr(`file_key`, 16)
WHERE `file_key` GLOB 'skill:tasklite-?*';
--> statement-breakpoint
UPDATE OR IGNORE `drift`
SET `file_key` = 'skill:docket-' || substr(`file_key`, 16)
WHERE `file_key` GLOB 'skill:tasklite-?*';
--> statement-breakpoint
UPDATE `installs`
SET `manifest` = (
  SELECT json_group_object(
    CASE WHEN j.key GLOB 'skill:tasklite-?*' THEN 'skill:docket-' || substr(j.key, 16) ELSE j.key END,
    CASE WHEN j.key GLOB 'skill:tasklite-?*' THEN json_set(j.value, '$.installed_as', substr(j.key, 7)) ELSE json(j.value) END
  )
  FROM json_each(`installs`.`manifest`) AS j
)
WHERE json_valid(`manifest`) AND `manifest` LIKE '%"skill:tasklite-%';
--> statement-breakpoint
UPDATE `instruction_reports`
SET `files` = (
  SELECT json_group_object(
    CASE WHEN j.key GLOB 'skill:tasklite-?*' THEN 'skill:docket-' || substr(j.key, 16) ELSE j.key END,
    json(j.value)
  )
  FROM json_each(`instruction_reports`.`files`) AS j
)
WHERE json_valid(`files`) AND `files` LIKE '%"skill:tasklite-%';
