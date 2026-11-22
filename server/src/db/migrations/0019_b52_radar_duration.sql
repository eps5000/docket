-- B52: how long the last radar run took (bookkeeping on the project; null until the next run).
ALTER TABLE `projects` ADD `radar_last_duration_ms` integer;