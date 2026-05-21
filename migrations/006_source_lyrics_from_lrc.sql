ALTER TABLE lyric_units
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS source_file text,
  ADD COLUMN IF NOT EXISTS source_line_index integer,
  ADD COLUMN IF NOT EXISTS start_time_seconds numeric(10, 3);

DO $$
BEGIN
  ALTER TABLE lyric_units
    ADD CONSTRAINT lyric_units_source_key_check
    CHECK (source_key IS NULL OR source_key IN ('zh', 'en'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE lyric_units
    ADD CONSTRAINT lyric_units_start_time_seconds_check
    CHECK (start_time_seconds IS NULL OR start_time_seconds >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_lyric_units_source_key
  ON lyric_units (source_key, source_line_index)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS lyric_source_versions (
  source_key text PRIMARY KEY,
  file_path text NOT NULL,
  file_hash text NOT NULL,
  file_mtime_ms bigint NOT NULL,
  lyric_count integer NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lyric_source_versions_source_key_check CHECK (source_key IN ('zh', 'en')),
  CONSTRAINT lyric_source_versions_lyric_count_check CHECK (lyric_count > 0)
);

COMMENT ON COLUMN lyric_units.source_key IS '歌词来源标识：zh 为中文版 LRC，en 为英文版 LRC';
COMMENT ON COLUMN lyric_units.source_file IS '歌词来源 LRC 文件名';
COMMENT ON COLUMN lyric_units.source_line_index IS '歌词在来源 LRC 文件中的行号';
COMMENT ON COLUMN lyric_units.start_time_seconds IS '歌词在来源音频中的开始时间，单位秒';

COMMENT ON TABLE lyric_source_versions IS '歌词 LRC 来源版本记录表';
COMMENT ON COLUMN lyric_source_versions.source_key IS '歌词来源标识：zh 为中文版 LRC，en 为英文版 LRC';
COMMENT ON COLUMN lyric_source_versions.file_path IS '来源 LRC 文件路径';
COMMENT ON COLUMN lyric_source_versions.file_hash IS '来源 LRC 文件内容 SHA-256 指纹';
COMMENT ON COLUMN lyric_source_versions.file_mtime_ms IS '来源 LRC 文件修改时间，Unix 毫秒';
COMMENT ON COLUMN lyric_source_versions.lyric_count IS '最近一次同步解析出的歌词句数';
COMMENT ON COLUMN lyric_source_versions.synced_at IS '最近一次同步时间';
COMMENT ON COLUMN lyric_source_versions.updated_at IS '记录更新时间';
