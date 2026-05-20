# MyVlog 视频素材收集系统

用于收集《友谊地久天长》合唱视频素材，并按“参与者、视频、歌词句子、关联关系、Relink 任务”管理。

## 功能

- PostgreSQL 存储人员、视频、歌词、视频歌词关联、Relink 暂存任务。
- 上传者可填写姓名、联系方式、备注，选择歌词并上传多个视频。
- 管理员可审核或驳回待整理视频。
- 管理员可编辑单句歌词文字，原有关联保持不变。
- 管理员可整体保存歌词结构，旧关联进入 Relink 暂存区。
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

安装依赖并初始化数据库：

```bash
npm install
npm run db:init
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

所有业务表字段都在 SQL 中写了中文 `COMMENT ON COLUMN`。

## 文件存储

上传视频默认保存到：

```text
storage/videos/
```

该目录内容已被 `.gitignore` 忽略，只保留 `.gitkeep`。

## 常用命令

```bash
npm run check
npm run db:init
npm run dev
npm start
```
