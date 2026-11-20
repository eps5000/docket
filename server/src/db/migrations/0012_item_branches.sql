-- Several branches per item (decision 36; BUILD_SPEC §5.21 B41). Additive: a nullable JSON column
-- on items holding the reported branches, `[{name, by, at}]`, which the radar reads by item id (no
-- index needed). No table is rebuilt.
ALTER TABLE `items` ADD `branches` text;--> statement-breakpoint
-- Each item's B40 reported branch moves into the set: the newest of the item's own report (or
-- clear), its latest packet's, its latest lead run's and its latest claim's (on a tie, the item's
-- own, then the claim's, the run's, the packet's). A newest clear leaves the set empty.
UPDATE `items` SET `branches` = (
  SELECT CASE WHEN r.name IS NULL THEN NULL
    ELSE json_array(json_object('name', r.name, 'by', r.who, 'at', r.at)) END
  FROM (
    SELECT i2.branch AS name, i2.branch_by AS who, i2.branch_at AS at, 4 AS rank
      FROM items i2 WHERE i2.id = items.id AND i2.branch_at IS NOT NULL
    UNION ALL
    SELECT * FROM (
      SELECT p.branch, p.created_by, p.created_at, 1 FROM packets p
      WHERE p.item_id = items.id AND p.branch IS NOT NULL ORDER BY p.round DESC LIMIT 1)
    UNION ALL
    SELECT * FROM (
      SELECT json_extract(u.workspace, '$.branch'),
        CASE WHEN u.client IS NULL THEN NULL WHEN u.label IS NULL THEN u.client
          ELSE u.client || ' · ' || u.label END,
        u.created_at, 2 FROM runs u
      WHERE u.item_id = items.id AND u.is_lead = 1 AND json_extract(u.workspace, '$.branch') IS NOT NULL
      ORDER BY u.created_at DESC LIMIT 1)
    UNION ALL
    SELECT * FROM (
      SELECT json_extract(e.data, '$.branch'),
        CASE WHEN e.client IS NULL THEN NULL WHEN e.label IS NULL THEN e.client
          ELSE e.client || ' · ' || e.label END,
        e.at, 3 FROM events e
      WHERE e.item_id = items.id AND e.type = 'claim.granted' AND json_extract(e.data, '$.branch') IS NOT NULL
      ORDER BY e.seq DESC LIMIT 1)
  ) r
  ORDER BY r.at DESC, r.rank DESC LIMIT 1
);
