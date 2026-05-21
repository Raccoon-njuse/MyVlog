-- 取消管理员审批后，历史待整理视频直接转为已公开，待确认歌词关联转为已确认。
UPDATE videos
SET status = 'reviewed',
    updated_at = now()
WHERE status = 'uploaded';

UPDATE video_lyric_links
SET status = 'active',
    updated_at = now()
WHERE status = 'pending'
  AND video_id IN (
    SELECT id
    FROM videos
    WHERE status = 'reviewed'
  );
