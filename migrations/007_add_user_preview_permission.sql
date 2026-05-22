ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS can_preview_all_videos boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_persons_lower_name
  ON persons ((lower(name)));

COMMENT ON COLUMN persons.can_preview_all_videos IS '是否允许该姓名用户在上传者页面预览所有用户的公开视频素材';
