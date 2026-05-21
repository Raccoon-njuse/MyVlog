ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS playback_file_url text,
  ADD COLUMN IF NOT EXISTS transcode_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS transcode_error text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS original_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS playback_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS playback_bitrate integer,
  ADD COLUMN IF NOT EXISTS transcoded_at timestamptz;

DO $$
BEGIN
  ALTER TABLE videos
    ADD CONSTRAINT videos_transcode_status_check
    CHECK (transcode_status IN ('pending', 'processing', 'ready', 'failed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_videos_transcode_status ON videos (transcode_status);

UPDATE videos
SET transcode_status = 'pending',
    transcode_error = COALESCE(transcode_error, ''),
    updated_at = now()
WHERE playback_file_url IS NULL
  AND transcode_status = 'ready';

COMMENT ON COLUMN videos.playback_file_url IS '低码率播放副本访问地址，未转码完成时为空';
COMMENT ON COLUMN videos.transcode_status IS '转码状态：pending、processing、ready、failed';
COMMENT ON COLUMN videos.transcode_error IS '最近一次转码失败原因';
COMMENT ON COLUMN videos.original_size_bytes IS '原始上传文件大小，单位字节';
COMMENT ON COLUMN videos.playback_size_bytes IS '低码率播放副本文件大小，单位字节';
COMMENT ON COLUMN videos.playback_bitrate IS '低码率播放副本总码率，单位 bit/s';
COMMENT ON COLUMN videos.transcoded_at IS '低码率播放副本生成时间';
