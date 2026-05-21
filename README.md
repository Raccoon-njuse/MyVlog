# MyVlog 视频素材收集系统

用于收集《友谊地久天长》合唱视频素材，并按“参与者、视频、歌词句子、关联关系、Relink 任务”管理。

## 功能

- PostgreSQL 存储人员、视频、歌词、视频歌词关联、Relink 暂存任务。
- 访客页不需要登录，歌词行覆盖数量会统计已上传且未驳回、未归档的素材；访客接口只返回已审核、已激活的视频详情。
- 上传者页使用姓名登录，不需要密码；上传者可上传素材并查看自己名下的视频状态。
- 管理员页使用姓名登录，不需要密码；管理员姓名固定为 `raccoon`。
- 管理员可审核或驳回待整理视频，编辑单句歌词文字，整体保存歌词结构，并处理 Relink 暂存任务。

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

## 页面与角色

当前前端按路径拆成三个页面：

- `/`：访客总览采用移动端优先界面。页面以歌词行列表为主，每行右侧只显示覆盖数量，待审核素材也会计入覆盖占位，`0` 会以红色提示；底部悬浮加号会打开姓名输入抽屉，普通姓名进入上传者页面，`raccoon` 进入管理员页面。
- `/uploader`：上传者页面采用移动端优先界面。用户直接输入姓名登录；页面仍以歌词为主，自己上传过的视频会在对应歌词行显示“我的”标注，点击歌词行后在行内展开该句下自己的视频。底部悬浮加号打开上传表单。
- `/admin`：管理员后台。只有输入 `raccoon` 才会加载后台数据；歌词编辑、结构保存、审核、驳回和 Relink 处理接口都会校验该姓名。

当前登录只是轻量姓名识别，不做密码、会话签名或服务端持久 session。前端会把姓名保存在浏览器 `localStorage`，请求需要识别身份的接口时通过 URL 编码后的 `X-User-Name` 请求头传给后端，以支持中文姓名。

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
[video-static] GET /storage/videos/example.mp4 status=206 range=bytes=0- contentRange=bytes 0-1023/4096 contentType=video/mp4 bytes=1024 durationMs=2.3
```

排查服务器卡顿时，优先确认浏览器播放请求是否带 `Range`，服务端是否返回 `206`，以及 `durationMs` 是否明显升高。

`.mov` 上传文件会按 `video/mp4` 响应给浏览器，避免部分浏览器把 H.264/AAC 的 MOV 片段按 `video/quicktime` 拒绝播放。若浏览器控制台仍出现 `[video-preview]` 的 `error` 事件，需要重点看其中的 `error.code`、`error.message` 和 `canPlayMp4`。

## 常用命令

```bash
npm run check
npm run db:migrate
npm run dev
npm start
```
