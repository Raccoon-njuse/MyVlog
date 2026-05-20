INSERT INTO lyric_units (order_index, text)
SELECT *
FROM (
  VALUES
    (1, 'Should old acquaintance be forgot'),
    (2, 'And never brought to mind'),
    (3, 'Should old acquaintance be forgot'),
    (4, 'And days of auld lang syne'),
    (5, 'For auld lang syne, my dear'),
    (6, 'For auld lang syne'),
    (7, 'We''ll take a cup of kindness yet'),
    (8, 'For auld lang syne')
) AS seed(order_index, text)
WHERE NOT EXISTS (
  SELECT 1
  FROM lyric_units
  WHERE lyric_units.is_active = true
);
