# 《友谊地久天长》视频收集网站详细设计

## 1. 目标

本项目用于展示《友谊地久天长》合唱视频的素材收集进度，并允许新参与者上传视频。核心问题不是在线剪辑，而是把“人、视频、歌词句子、关联关系、待整理状态”管理清楚，方便后续人工剪辑。

第一版保持最小可用：

- 展示每句歌词当前已收集多少视频。
- 允许参与者上传一个或多个视频。
- 允许一个人有多个视频。
- 允许一个视频关联一句或多句歌词。
- 允许多人重复唱同一句歌词。
- 允许管理员前端编辑歌词。
- 歌词结构变化后，受影响的视频进入待重新关联暂存区。

暂不做：

- 在线视频剪辑。
- 自动识别歌词。
- 自动音频对齐。
- 复杂权限系统。
- 多歌曲管理。

## 2. 用户角色

### 2.1 访客

查看整体收集情况，知道哪些歌词已经有人唱、哪些还缺素材。

### 2.2 上传者

填写姓名，选择自己唱的歌词句子，上传视频。上传后素材进入待审核或待整理状态。

### 2.3 管理员

整理人员、视频和歌词之间的关系；审核视频；编辑歌词；处理待重新关联任务。

## 3. 页面结构

### 3.1 收集总览页

用途：对外展示素材进度。

内容：

- 顶部统计：歌词句数、已收视频数、参与人数、待整理数量。
- 歌词列表：按顺序展示每句歌词。
- 每句歌词展示：已关联视频数量、参与者、状态。
- 句子详情：点击某句后展示对应视频缩略图和上传者。
- 上传入口：可从某句歌词直接进入上传页，并默认选择该句。

### 3.2 上传页

用途：让参与者提交素材。

字段：

- 姓名。
- 联系方式，可选。
- 备注，可选。
- 选择歌词句子，可多选。
- 上传视频，可多文件。

提交后：

- 创建或匹配 `Person`。
- 创建 `Video`。
- 创建初始 `VideoLyricLink`，状态为待确认。
- 视频整体状态为 `uploaded`。

### 3.3 管理后台

用途：管理员整理素材。

模块：

- 待整理视频。
- 人员列表。
- 视频列表。
- 歌词编辑。
- 视频与歌词手动关联。
- Relink 暂存区。

### 3.4 Relink 暂存区

用途：歌词结构变化后，集中处理受影响的视频关系。

触发场景：

- 删除歌词句子。
- 一句拆成多句。
- 多句合并成一句。
- 重排歌词结构。

不触发场景：

- 改错字。
- 改标点。
- 调整空格。
- 修改显示分段名。

## 4. 数据模型

字段说明使用中文，后续创建数据库时也应给所有字段添加中文注释。

### 4.1 Person：参与者

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 参与者唯一标识 |
| name | string | 参与者原始姓名 |
| display_name | string | 页面展示名 |
| contact | string | 联系方式，可为空 |
| note | text | 管理员备注 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### 4.2 Video：视频

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 视频唯一标识 |
| person_id | string | 上传者标识 |
| file_url | string | 视频文件访问地址 |
| thumbnail_url | string | 视频缩略图地址 |
| original_filename | string | 原始文件名 |
| duration_seconds | number | 视频时长，单位秒 |
| status | enum | 视频状态：uploaded、reviewed、rejected、archived |
| note | text | 管理员备注 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### 4.3 LyricUnit：歌词句子

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 歌词句子唯一标识 |
| order_index | number | 歌词展示顺序 |
| text | text | 歌词正文 |
| section_label | string | 段落标签，例如第一段、副歌 |
| is_active | boolean | 是否仍在当前歌词版本中使用 |
| version | number | 歌词版本号 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### 4.4 VideoLyricLink：视频歌词关联

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 关联关系唯一标识 |
| video_id | string | 视频标识 |
| lyric_unit_id | string | 歌词句子标识 |
| video_start_time | number | 视频中该句开始时间，可为空 |
| video_end_time | number | 视频中该句结束时间，可为空 |
| status | enum | 关联状态：pending、active、needs_relink、archived |
| note | text | 关联备注 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### 4.5 RelinkTask：待重新关联任务

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 任务唯一标识 |
| video_id | string | 受影响的视频标识 |
| previous_link_id | string | 原关联关系标识 |
| old_lyric_unit_id | string | 原歌词句子标识 |
| old_lyric_text | text | 原歌词文本快照 |
| reason | string | 需要重新关联的原因 |
| status | enum | 任务状态：pending、resolved、ignored |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

## 5. 核心状态流转

### 5.1 上传视频流转

```text
uploaded -> reviewed -> archived
uploaded -> rejected
```

- `uploaded`：刚上传，等待管理员整理。
- `reviewed`：管理员确认可用于展示。
- `rejected`：素材不可用，不公开展示。
- `archived`：历史素材保留，但不参与当前展示。

### 5.2 视频歌词关联流转

```text
pending -> active
active -> needs_relink -> active
active -> archived
```

- `pending`：上传者选择了歌词，但管理员未确认。
- `active`：当前有效关联。
- `needs_relink`：歌词结构变化后需要人工处理。
- `archived`：历史关联，不参与当前统计。

## 6. 歌词编辑规则

### 6.1 普通编辑

如果只修改文本内容，不改变句子数量和含义边界，则保留 `LyricUnit.id`。

示例：

- `Should auld acquaintance be forgot` 改成 `Should old acquaintance be forgot`
- 逗号、句号、空格调整。

结果：

- 原视频关联继续有效。
- 不生成 RelinkTask。

### 6.2 结构编辑

如果改变歌词句子的边界，则生成新歌词结构，并把受影响关联标记为 `needs_relink`。

示例：

- 一句拆成两句。
- 两句合并成一句。
- 删除一句。
- 重排歌词顺序。

结果：

- 旧 `VideoLyricLink.status` 改为 `needs_relink`。
- 创建 `RelinkTask`。
- 管理员在暂存区手动选择新的 `LyricUnit`。

### 6.3 建议交互

歌词编辑器分为两种保存按钮：

- `保存文字修改`：只改文本，不触发 relink。
- `保存结构修改`：可能触发 relink，保存前显示影响数量。

## 7. 文件存储

第一版建议使用本地目录：

```text
storage/
  videos/
  thumbnails/
```

数据库只保存路径或 URL。后续需要公网访问时，可以把同样的数据结构迁移到对象存储。

上传文件命名建议：

```text
{video_id}-{safe_original_name}.mp4
```

这样既能避免重名，也方便人工排查来源。

## 8. MVP 技术方案

最小实现建议：

- 前端：静态 HTML 原型先确认信息架构。
- 后续正式版：React 或 Next.js。
- 后端：先用轻量 API。
- 数据库：SQLite 起步。
- 文件处理：后续接入 ffmpeg 生成缩略图和读取时长。

第一版正式开发可以按以下顺序：

1. 建立数据模型和本地 SQLite。
2. 实现歌词管理。
3. 实现人员和视频上传。
4. 实现视频与歌词手动关联。
5. 实现公开收集总览。
6. 实现 Relink 暂存区。

## 9. 当前 HTML 预览说明

`preview/index.html` 是静态粗糙版，用假数据模拟主要页面状态：

- 左侧是歌词收集进度。
- 中间展示选中歌词对应的视频。
- 右侧展示上传和管理入口。
- 底部展示待整理视频和 Relink 暂存区。

该预览不包含真实上传能力，目的是先确认页面组织方式和信息密度。
