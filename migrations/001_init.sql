CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE video_status AS ENUM ('uploaded', 'reviewed', 'rejected', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE link_status AS ENUM ('pending', 'active', 'needs_relink', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE relink_status AS ENUM ('pending', 'resolved', 'ignored');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS persons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  display_name text NOT NULL,
  contact text,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lyric_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_index integer NOT NULL,
  text text NOT NULL,
  section_label text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  file_url text NOT NULL,
  thumbnail_url text,
  original_filename text NOT NULL,
  duration_seconds numeric(10, 3),
  status video_status NOT NULL DEFAULT 'uploaded',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS video_lyric_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  lyric_unit_id uuid NOT NULL REFERENCES lyric_units(id) ON DELETE RESTRICT,
  video_start_time numeric(10, 3),
  video_end_time numeric(10, 3),
  status link_status NOT NULL DEFAULT 'pending',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relink_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  previous_link_id uuid NOT NULL REFERENCES video_lyric_links(id) ON DELETE CASCADE,
  old_lyric_unit_id uuid NOT NULL REFERENCES lyric_units(id) ON DELETE RESTRICT,
  old_lyric_text text NOT NULL,
  reason text NOT NULL,
  status relink_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_persons_name_contact ON persons (name, contact);
CREATE INDEX IF NOT EXISTS idx_videos_person_id ON videos (person_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos (status);
CREATE INDEX IF NOT EXISTS idx_lyric_units_active_order ON lyric_units (is_active, order_index);
CREATE INDEX IF NOT EXISTS idx_video_lyric_links_lyric_status ON video_lyric_links (lyric_unit_id, status);
CREATE INDEX IF NOT EXISTS idx_video_lyric_links_video_id ON video_lyric_links (video_id);
CREATE INDEX IF NOT EXISTS idx_relink_tasks_status ON relink_tasks (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relink_tasks_previous_link_pending
  ON relink_tasks (previous_link_id)
  WHERE status = 'pending';

COMMENT ON TYPE video_status IS '视频状态枚举';
COMMENT ON TYPE link_status IS '视频与歌词关联状态枚举';
COMMENT ON TYPE relink_status IS '重新关联任务状态枚举';

COMMENT ON TABLE persons IS '参与者表';
COMMENT ON COLUMN persons.id IS '参与者唯一标识';
COMMENT ON COLUMN persons.name IS '参与者原始姓名';
COMMENT ON COLUMN persons.display_name IS '页面展示名';
COMMENT ON COLUMN persons.contact IS '联系方式，可为空';
COMMENT ON COLUMN persons.note IS '管理员备注';
COMMENT ON COLUMN persons.created_at IS '创建时间';
COMMENT ON COLUMN persons.updated_at IS '更新时间';

COMMENT ON TABLE lyric_units IS '歌词句子表';
COMMENT ON COLUMN lyric_units.id IS '歌词句子唯一标识';
COMMENT ON COLUMN lyric_units.order_index IS '歌词展示顺序';
COMMENT ON COLUMN lyric_units.text IS '歌词正文';
COMMENT ON COLUMN lyric_units.section_label IS '段落标签，例如第一段、副歌';
COMMENT ON COLUMN lyric_units.is_active IS '是否仍在当前歌词版本中使用';
COMMENT ON COLUMN lyric_units.version IS '歌词版本号';
COMMENT ON COLUMN lyric_units.created_at IS '创建时间';
COMMENT ON COLUMN lyric_units.updated_at IS '更新时间';

COMMENT ON TABLE videos IS '视频素材表';
COMMENT ON COLUMN videos.id IS '视频唯一标识';
COMMENT ON COLUMN videos.person_id IS '上传者标识';
COMMENT ON COLUMN videos.file_url IS '视频文件访问地址';
COMMENT ON COLUMN videos.thumbnail_url IS '视频缩略图地址';
COMMENT ON COLUMN videos.original_filename IS '原始文件名';
COMMENT ON COLUMN videos.duration_seconds IS '视频时长，单位秒';
COMMENT ON COLUMN videos.status IS '视频状态：uploaded、reviewed、rejected、archived';
COMMENT ON COLUMN videos.note IS '管理员备注';
COMMENT ON COLUMN videos.created_at IS '创建时间';
COMMENT ON COLUMN videos.updated_at IS '更新时间';

COMMENT ON TABLE video_lyric_links IS '视频与歌词关联表';
COMMENT ON COLUMN video_lyric_links.id IS '关联关系唯一标识';
COMMENT ON COLUMN video_lyric_links.video_id IS '视频标识';
COMMENT ON COLUMN video_lyric_links.lyric_unit_id IS '歌词句子标识';
COMMENT ON COLUMN video_lyric_links.video_start_time IS '视频中该句开始时间，可为空';
COMMENT ON COLUMN video_lyric_links.video_end_time IS '视频中该句结束时间，可为空';
COMMENT ON COLUMN video_lyric_links.status IS '关联状态：pending、active、needs_relink、archived';
COMMENT ON COLUMN video_lyric_links.note IS '关联备注';
COMMENT ON COLUMN video_lyric_links.created_at IS '创建时间';
COMMENT ON COLUMN video_lyric_links.updated_at IS '更新时间';

COMMENT ON TABLE relink_tasks IS '待重新关联任务表';
COMMENT ON COLUMN relink_tasks.id IS '任务唯一标识';
COMMENT ON COLUMN relink_tasks.video_id IS '受影响的视频标识';
COMMENT ON COLUMN relink_tasks.previous_link_id IS '原关联关系标识';
COMMENT ON COLUMN relink_tasks.old_lyric_unit_id IS '原歌词句子标识';
COMMENT ON COLUMN relink_tasks.old_lyric_text IS '原歌词文本快照';
COMMENT ON COLUMN relink_tasks.reason IS '需要重新关联的原因';
COMMENT ON COLUMN relink_tasks.status IS '任务状态：pending、resolved、ignored';
COMMENT ON COLUMN relink_tasks.created_at IS '创建时间';
COMMENT ON COLUMN relink_tasks.updated_at IS '更新时间';
