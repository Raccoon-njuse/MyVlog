# MyVlog 视频素材收集系统

用于收集《友谊地久天长》合唱视频素材，并按“参与者、视频、歌词句子、关联关系、Relink 任务”管理。

## 功能

- PostgreSQL 存储人员、视频、歌词、视频歌词关联、Relink 暂存任务。
- 上传视频会保留原始文件，并同步生成低码率 MP4 播放副本；前端只播放低码率副本，未转码完成的视频不会挂载播放器。
- 访客页不需要登录，歌词行覆盖数量会统计已公开、已激活的可播放素材；访客接口只返回已公开的视频详情。
- 上传者页使用姓名登录，不需要密码；上传者可上传素材并查看自己名下的视频状态。
- 管理员页使用姓名登录，不需要密码；管理员姓名固定为 `raccoon`。
- 用户上传的视频完成转码后直接进入已公开状态；管理员可删除视频、编辑单句歌词文字、整体保存歌词结构，并处理 Relink 暂存任务。

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

- `/`：访客总览采用移动端优先界面。页面以歌词行列表为主，每行右侧只显示覆盖数量，`0` 会以红色提示；顶栏只保留“友谊地久天长”和“登录”，普通姓名进入上传者页面，`raccoon` 进入管理员页面，访客页不提供添加按钮。
- `/uploader`：上传者页面采用移动端优先界面。用户直接输入姓名登录；页面仍以歌词为主，自己上传过的视频会在对应歌词行显示“我的”标注，点击歌词行后在行内展开该句下自己的视频。顶栏“添加视频”会先进入歌词选择模式，每行前出现选框且整行可切换选择；此时顶栏按钮变为“下一步”，右侧 `×` 用于取消本次选择。未选择歌词时也可继续上传，视频会作为只绑定参与者的花絮保存。
- `/admin`：管理员后台。只有输入 `raccoon` 才会加载后台数据；后台不显示侧边导航，只保留退出登录、歌词管理、视频删除、歌词结构编辑和 Relink 处理。
- `/test`：独立视频播放测试页。该页面公开展示数据库中的所有视频记录，不按审核状态过滤；它不复用主应用的延迟挂载逻辑，而是直接给已转码视频写入带缓存戳的低码率播放副本地址。页面优先使用 CDN 版 Video.js，加载失败时回退到浏览器原生播放器。

当前登录只是轻量姓名识别，不做密码、会话签名或服务端持久 session。前端会把姓名保存在浏览器 `localStorage`，请求需要识别身份的接口时通过 URL 编码后的 `X-User-Name` 请求头传给后端，以支持中文姓名。

## 数据库

迁移文件在 `migrations/`：

- `001_init.sql`：创建 PostgreSQL 扩展、枚举、表、索引、中文注释。
- `002_seed_lyrics.sql`：初始化默认歌词。
- `003_remove_lyric_sections.sql`：删除已弃用的歌词分段字段。
- `004_add_video_transcoding_fields.sql`：为视频表增加低码率播放副本地址、转码状态、转码错误和文件体积/码率字段。
- `005_auto_publish_uploaded_videos.sql`：取消管理员审批后，把历史待整理视频转为已公开，并把待确认歌词关联转为已确认。

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

原始上传文件和低码率播放副本会保存在同一目录。播放副本命名规则为原始落盘文件名追加 `-playback.mp4`，例如：

```text
storage/videos/<uuid>-example.mov
storage/videos/<uuid>-example-playback.mp4
```

上传接口会等待 ffmpeg 转码完成后才返回成功，前端上传抽屉会显示“上传/转码中”的状态。默认播放副本使用最长边不超过 `960px`、视频约 `1000k`、音频 `96k` 的 MP4，可通过 `PLAYBACK_MAX_DIMENSION`、`PLAYBACK_VIDEO_BITRATE`、`PLAYBACK_MAX_RATE`、`PLAYBACK_BUFFER_SIZE`、`PLAYBACK_AUDIO_BITRATE` 调整。服务启动后会自动补转历史未转码视频；补转完成前这些视频在页面中只显示转码状态，不允许播放。

## 视频播放排查

前端视频预览使用 `preload="none"`，并只在视频进入视口或用户准备播放时挂载真实 `src`，避免列表页一次性触发大量视频预加载请求。同一页面开始播放一个视频时，会暂停其它正在播放的视频，降低服务器并发传输压力。

浏览器控制台会输出 `[video-preview]` 日志，重点关注 `waiting`、`stalled`、`error` 事件中的 `currentTime`、`buffered`、`readyState` 和 `networkState`。

`/test` 用于排查真实视频文件播放问题。打开页面时会请求 `/api/test/videos` 获取所有视频，并为每个可播放副本地址追加 `testSession` 缓存戳；点击“刷新并绕过缓存”会生成新的缓存戳并重新挂载播放器。该页面会在页面右侧和浏览器控制台输出 `[test-video]` 事件日志，便于和服务端静态资源日志对照。

上传带宽可通过 `/api/test/upload-bandwidth` 测试。该接口只读取请求体并丢弃数据，不创建视频记录、不写入 `storage/videos/`，默认最多接收 120MB。测试时需要使用 `Content-Type: application/octet-stream`，避免被普通表单解析中间件按 1MB 表单限制拦截。服务端会输出 `[upload-test]` 日志，响应 JSON 也会包含 `bytes`、`durationMs`、`bytesPerSecond` 和 `mbps`。

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
