INSERT INTO lyric_units (order_index, text, section_label)
SELECT *
FROM (
  VALUES
    (1, 'Should old acquaintance be forgot', '第一段'),
    (2, 'And never brought to mind', '第一段'),
    (3, 'Should old acquaintance be forgot', '第一段'),
    (4, 'And days of auld lang syne', '第一段'),
    (5, 'For auld lang syne, my dear', '副歌'),
    (6, 'For auld lang syne', '副歌'),
    (7, 'We''ll take a cup of kindness yet', '副歌'),
    (8, 'For auld lang syne', '副歌')
) AS seed(order_index, text, section_label)
WHERE NOT EXISTS (
  SELECT 1
  FROM lyric_units
  WHERE lyric_units.is_active = true
);
