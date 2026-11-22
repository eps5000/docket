-- docket-wait (owner decision 40; BUILD_SPEC §5.11; B48): `drift.file_key` also
-- allows the two installed scripts, so the scheduled push check can record drift
-- on them. Nothing else changes: proposals and agent reports keep their narrower
-- keys. `drift` is rebuilt (SQLite cannot alter a CHECK), every row copied
-- unchanged; as for 0008, `migrateDb` turns foreign keys off around the run and
-- checks `PRAGMA foreign_key_check` afterwards.
CREATE TABLE `__new_drift` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`project_key` text,
	`file_key` text NOT NULL,
	`change` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`local_sha256` text,
	`report_id` text,
	`detected_at` text NOT NULL,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_key`) REFERENCES `projects`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`report_id`) REFERENCES `instruction_reports`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "drift_state" CHECK("state" IN ('open', 'adopted', 'restored', 'kept_local')),
	CONSTRAINT "drift_change" CHECK("change" IN ('edited', 'missing', 'extra')),
	CONSTRAINT "drift_file_key" CHECK("file_key" IN ('connection', 'script:docket-wait.sh', 'script:docket-wait.ps1') OR ("file_key" = 'agents_block' OR ("file_key" GLOB 'skill:?*' AND length("file_key") <= 66 AND substr("file_key", 7) NOT GLOB '*[^a-z0-9-]*'))),
	CONSTRAINT "drift_local_sha256" CHECK(CASE WHEN "change" = 'missing' THEN "local_sha256" IS NULL ELSE "local_sha256" IS NOT NULL AND length("local_sha256") = 64 END),
	CONSTRAINT "drift_resolved" CHECK(("state" = 'open') = ("resolved_at" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_drift`("id", "install_id", "project_key", "file_key", "change", "state", "local_sha256", "report_id", "detected_at", "resolved_at", "created_at", "updated_at") SELECT "id", "install_id", "project_key", "file_key", "change", "state", "local_sha256", "report_id", "detected_at", "resolved_at", "created_at", "updated_at" FROM `drift`;--> statement-breakpoint
DROP TABLE `drift`;--> statement-breakpoint
ALTER TABLE `__new_drift` RENAME TO `drift`;--> statement-breakpoint
CREATE UNIQUE INDEX `drift_open_install_file` ON `drift` (`install_id`,`file_key`) WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX `drift_project_state` ON `drift` (`project_key`,`state`);