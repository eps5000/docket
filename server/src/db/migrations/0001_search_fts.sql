-- Full-text search over items (BUILD_SPEC §4 `search_fts`): ID, title,
-- description, outcome, label names and Jira key. Kept in sync by triggers,
-- so no adapter has to remember to update it. Rows are matched by item ID,
-- never by rowid, so VACUUM (and VACUUM INTO backups) cannot desynchronise it.
CREATE VIRTUAL TABLE `search_fts` USING fts5(
	id, title, description_md, outcome_md, labels, jira_key,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
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
CREATE TRIGGER `search_fts_item_labels_insert` AFTER INSERT ON `item_labels` BEGIN
	UPDATE search_fts SET labels = coalesce((SELECT group_concat(name, ' ') FROM (
		SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id
		WHERE il.item_id = new.item_id ORDER BY l.name)), '')
	WHERE id = new.item_id;
END;
--> statement-breakpoint
CREATE TRIGGER `search_fts_item_labels_delete` AFTER DELETE ON `item_labels` BEGIN
	UPDATE search_fts SET labels = coalesce((SELECT group_concat(name, ' ') FROM (
		SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id
		WHERE il.item_id = old.item_id ORDER BY l.name)), '')
	WHERE id = old.item_id;
END;
--> statement-breakpoint
CREATE TRIGGER `search_fts_labels_rename` AFTER UPDATE OF name ON `labels` BEGIN
	UPDATE search_fts SET labels = coalesce((SELECT group_concat(name, ' ') FROM (
		SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id
		WHERE il.item_id = search_fts.id ORDER BY l.name)), '')
	WHERE id IN (SELECT item_id FROM item_labels WHERE label_id = new.id);
END;
