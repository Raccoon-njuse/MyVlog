# MyVlog 视频素材收集系统

用于收集《友谊地久天长》合唱视频素材，并按“参与者、视频、歌词句子、关联关系、Relink 任务”管理。

## 功能

- PostgreSQL 存储人员、视频、歌词、视频歌词关联、Relink 暂存任务。
- 上传者可填写姓名、联系方式、备注，选择歌词并上传多个视频。
- 管理员可审核或驳回待整理视频。
- 管理员可编辑单句歌词文字，原有关联保持不变。
- 管理员可按“一行一句歌词”整体保存歌词结构，旧关联进入 Relink 暂存区。
- 管理员可把 Relink 任务重新指向新的歌词句子。

## 本地启动

复制环境变量：

```bash
cp .env.example .env
```

启动 PostgreSQL。优先使用 Docker：

```bash
docker compose up -d postgres
```

如果使用本机 PostgreSQL，确保 `.env` 中的 `DATABASE_URL` 指向可用数据库。

安装依赖并执行数据库迁移：

```bash
npm install
npm run db:migrate
```

启动开发服务：

```bash
npm run dev
```

访问：

```text
http://127.0.0.1:3000
```

## 数据库

迁移文件在 `migrations/`：

- `001_init.sql`：创建 PostgreSQL 扩展、枚举、表、索引、中文注释。
- `002_seed_lyrics.sql`：初始化默认歌词。
- `003_remove_lyric_sections.sql`：删除已弃用的歌词分段字段。

迁移执行记录保存在 `schema_migrations` 表中。服务端更新代码后，运行：

```bash
npm run db:migrate
```

该命令只执行尚未记录的新增迁移；旧命令 `npm run db:init` 仍可使用，当前只是 `db:migrate` 的兼容别名。

所有业务表字段都在 SQL 中写了中文 `COMMENT ON COLUMN`。

## 文件存储

上传视频默认保存到：

```text
storage/videos/
```

该目录内容已被 `.gitignore` 忽略，只保留 `.gitkeep`。

## 视频播放排查

前端视频预览使用 `preload="none"`，并只在视频进入视口或用户准备播放时挂载真实 `src`，避免列表页一次性触发大量视频预加载请求。同一页面开始播放一个视频时，会暂停其它正在播放的视频，降低服务器并发传输压力。

浏览器控制台会输出 `[video-preview]` 日志，重点关注 `waiting`、`stalled`、`error` 事件中的 `currentTime`、`buffered`、`readyState` 和 `networkState`。

服务端会为 `/storage/videos/...` 静态视频请求输出 `[video-static]` 日志，例如：

```text
[video-static] GET /storage/videos/example.mp4 status=206 range=bytes=0- contentRange=bytes 0-1023/4096 bytes=1024 durationMs=2.3
```

排查服务器卡顿时，优先确认浏览器播放请求是否带 `Range`，服务端是否返回 `206`，以及 `durationMs` 是否明显升高。

## 常用命令

```bash
npm run check
npm run db:migrate
npm run dev
npm start
```
