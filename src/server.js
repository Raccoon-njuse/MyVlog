import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import { pool, query, withTransaction } from "./db.js";

dotenv.config();

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const projectRoot = path.resolve(currentDir, "..");
const publicDir = path.join(projectRoot, "public");
const configuredUploadDir = process.env.UPLOAD_DIR || "storage/videos";
const uploadDir = path.isAbsolute(configuredUploadDir)
  ? configuredUploadDir
  : path.join(projectRoot, configuredUploadDir);
const uploadUrlPrefix = "/storage/videos";
const port = Number(process.env.PORT || 3000);
const adminUserName = String(process.env.ADMIN_NAME || "raccoon").toLowerCase();
const maxUploadTestBytes = Number(process.env.MAX_UPLOAD_TEST_BYTES || 1024 * 1024 * 120);
const ffmpegCommand = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobeCommand = process.env.FFPROBE_PATH || "ffprobe";
const playbackVideoBitrate = process.env.PLAYBACK_VIDEO_BITRATE || "1000k";
const playbackMaxRate = process.env.PLAYBACK_MAX_RATE || "1200k";
const playbackBufferSize = process.env.PLAYBACK_BUFFER_SIZE || "2400k";
const playbackAudioBitrate = process.env.PLAYBACK_AUDIO_BITRATE || "96k";
const playbackMaxDimension = Number(process.env.PLAYBACK_MAX_DIMENSION || 960);

fsSync.mkdirSync(uploadDir, { recursive: true });

const videoStaticOptions = {
  acceptRanges: true,
  cacheControl: true,
  immutable: true,
  maxAge: "7d",
  setHeaders(response, filePath) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (path.extname(filePath).toLowerCase() === ".mov") {
      // 浏览器对 video/quicktime 支持不稳定，H.264/AAC 的 MOV 片段按 MP4 交给 HTML5 video 解析。
      response.setHeader("Content-Type", "video/mp4");
    }
  }
};

// 清理文件名中不适合放进路径的字符。
function sanitizeFilename(originalName) {
  const baseName = path.basename(originalName || "video");
  const cleaned = baseName.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  return cleaned || "video";
}

// 返回 multer 写入文件的目标目录。
function resolveUploadDestination(_request, _file, callback) {
  callback(null, uploadDir);
}

// 为上传视频生成避免冲突的文件名。
function resolveUploadFilename(_request, file, callback) {
  const safeName = sanitizeFilename(file.originalname);
  callback(null, `${crypto.randomUUID()}-${safeName}`);
}

const storage = multer.diskStorage({
  destination: resolveUploadDestination,
  filename: resolveUploadFilename
});

const upload = multer({
  storage,
  limits: {
    files: 8,
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 600)
  }
});

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/", express.static(publicDir));
app.use(uploadUrlPrefix, logVideoAssetRequest, express.static(uploadDir, videoStaticOptions));

// 记录视频静态资源的 Range 请求，便于服务器排查播放卡顿。
function logVideoAssetRequest(request, response, next) {
  const startedAt = process.hrtime.bigint();
  const range = request.headers.range || "-";
  response.on("finish", function logVideoAssetResponse() {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const bytes = response.getHeader("content-length") || "-";
    const contentRange = response.getHeader("content-range") || "-";
    const contentType = response.getHeader("content-type") || "-";
    console.info(
      [
        "[video-static]",
        request.method,
        request.originalUrl,
        `status=${response.statusCode}`,
        `range=${range}`,
        `contentRange=${contentRange}`,
        `contentType=${contentType}`,
        `bytes=${bytes}`,
        `durationMs=${durationMs.toFixed(1)}`
      ].join(" ")
    );
  });
  next();
}

// 将数据库中的 snake_case 行转换成前端使用的结构。
function mapLyricRow(row) {
  const videos = row.videos || [];
  return {
    id: row.id,
    orderIndex: Number(row.order_index),
    text: row.text,
    videoCount: Number(row.video_count ?? videos.length),
    videos
  };
}

// 将数据库视频行整理成测试页使用的前端结构。
function mapTestVideoRow(row) {
  return {
    id: row.id,
    title: row.original_filename,
    fileUrl: row.playback_file_url,
    originalFileUrl: row.file_url,
    playbackFileUrl: row.playback_file_url,
    thumbnailUrl: row.thumbnail_url,
    status: row.status,
    transcodeStatus: row.transcode_status,
    transcodeError: row.transcode_error,
    originalSizeBytes: row.original_size_bytes,
    playbackSizeBytes: row.playback_size_bytes,
    playbackBitrate: row.playback_bitrate,
    durationSeconds: row.duration_seconds,
    personName: row.person_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lyricLinks: row.lyric_links || []
  };
}

// 输出上传测速结果，便于区分真实业务上传和纯链路测速。
function logUploadBandwidthTest(request, payload) {
  console.info(
    [
      "[upload-test]",
      request.method,
      request.originalUrl,
      `status=${payload.status}`,
      `bytes=${payload.bytes}`,
      `durationMs=${payload.durationMs}`,
      `bytesPerSecond=${payload.bytesPerSecond}`,
      `mbps=${payload.mbps}`,
      `remoteAddress=${request.ip || request.socket.remoteAddress || "-"}`
    ].join(" ")
  );
}

// 用于限制错误输出长度，避免 ffmpeg 大量日志淹没接口响应。
function appendLimitedText(current, addition, limit = 12000) {
  const next = `${current}${addition}`;
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

// 运行外部媒体工具，并收集必要的 stdout/stderr 诊断信息。
function runMediaCommand(command, args, options = {}) {
  return new Promise(function runMediaCommandPromise(resolve, reject) {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", function handleStdout(chunk) {
      stdout = appendLimitedText(stdout, chunk.toString());
    });
    child.stderr.on("data", function handleStderr(chunk) {
      stderr = appendLimitedText(stderr, chunk.toString());
    });
    child.on("error", reject);
    child.on("close", function handleClose(code) {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} 退出码 ${code}: ${stderr || stdout || "无输出"}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

// 将数值字符串转换为数据库可接受的数字或 null。
function toNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// 读取视频元数据，用于记录播放副本时长和码率。
async function probeVideoFile(filePath) {
  const result = await runMediaCommand(ffprobeCommand, [
    "-v", "error",
    "-show_entries", "format=duration,bit_rate",
    "-of", "json",
    filePath
  ]);
  const payload = JSON.parse(result.stdout || "{}");
  return {
    durationSeconds: toNullableNumber(payload.format?.duration),
    bitrate: toNullableNumber(payload.format?.bit_rate)
  };
}

// 根据原始文件名生成同目录下的低码率 MP4 副本文件名。
function resolvePlaybackFilename(originalFilename) {
  const parsed = path.parse(originalFilename);
  return `${parsed.name}-playback.mp4`;
}

// 将文件访问 URL 转回上传目录中的绝对路径。
function resolveUploadPathFromUrl(fileUrl) {
  const prefix = `${uploadUrlPrefix}/`;
  if (!fileUrl || !fileUrl.startsWith(prefix)) {
    throw new Error(`无法识别视频文件地址：${fileUrl || "-"}`);
  }
  const filename = path.basename(decodeURIComponent(fileUrl.slice(prefix.length)));
  return path.join(uploadDir, filename);
}

// 生成低码率播放副本；播放页只使用该副本，不直接播放原始上传文件。
async function transcodeVideoFile(inputPath, outputPath, label) {
  const startedAt = process.hrtime.bigint();
  const scaleFilter = [
    `w='min(${playbackMaxDimension},iw)'`,
    `h='min(${playbackMaxDimension},ih)'`,
    "force_original_aspect_ratio=decrease",
    "force_divisible_by=2"
  ].join(":");
  console.info(`[video-transcode] start label=${label} input=${inputPath} output=${outputPath}`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runMediaCommand(ffmpegCommand, [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-vf", `scale=${scaleFilter}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-profile:v", "main",
    "-pix_fmt", "yuv420p",
    "-b:v", playbackVideoBitrate,
    "-maxrate", playbackMaxRate,
    "-bufsize", playbackBufferSize,
    "-c:a", "aac",
    "-b:a", playbackAudioBitrate,
    "-movflags", "+faststart",
    outputPath
  ]);
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  console.info(`[video-transcode] finish label=${label} durationMs=${durationMs.toFixed(1)}`);
}

// 删除单个路径，清理失败时不覆盖原始业务错误。
async function cleanupFilePath(filePath) {
  if (!filePath) {
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch (_error) {
    // 清理失败不覆盖原始业务错误。
  }
}

// 上传接口等待转码完成后才创建业务记录，确保新视频一入库就可播放低码率副本。
async function prepareUploadedVideo(file) {
  const playbackFilename = resolvePlaybackFilename(file.filename);
  const playbackPath = path.join(uploadDir, playbackFilename);
  await transcodeVideoFile(file.path, playbackPath, file.originalname);
  const [originalStat, playbackStat, metadata] = await Promise.all([
    fs.stat(file.path),
    fs.stat(playbackPath),
    probeVideoFile(playbackPath)
  ]);
  return {
    file,
    originalFileUrl: `${uploadUrlPrefix}/${file.filename}`,
    playbackFileUrl: `${uploadUrlPrefix}/${playbackFilename}`,
    playbackPath,
    originalSizeBytes: originalStat.size,
    playbackSizeBytes: playbackStat.size,
    playbackBitrate: metadata.bitrate,
    durationSeconds: metadata.durationSeconds
  };
}

// 后台补转历史视频，迁移后未生成低码率副本的视频不会被页面播放。
async function processPendingTranscodes() {
  const result = await query(`
    SELECT id::text, file_url, original_filename
    FROM videos
    WHERE transcode_status IN ('pending', 'processing', 'failed')
      AND playback_file_url IS NULL
      AND status NOT IN ('rejected', 'archived')
    ORDER BY created_at ASC
  `);

  for (let i = 0; i < result.rows.length; i += 1) {
    const video = result.rows[i];
    const inputPath = resolveUploadPathFromUrl(video.file_url);
    const playbackFilename = resolvePlaybackFilename(path.basename(inputPath));
    const playbackPath = path.join(uploadDir, playbackFilename);
    const playbackFileUrl = `${uploadUrlPrefix}/${playbackFilename}`;
    await query(
      `
        UPDATE videos
        SET transcode_status = 'processing',
            transcode_error = '',
            updated_at = now()
        WHERE id = $1
      `,
      [video.id]
    );
    try {
      await transcodeVideoFile(inputPath, playbackPath, video.original_filename);
      const [originalStat, playbackStat, metadata] = await Promise.all([
        fs.stat(inputPath),
        fs.stat(playbackPath),
        probeVideoFile(playbackPath)
      ]);
      await query(
        `
          UPDATE videos
          SET playback_file_url = $1,
              transcode_status = 'ready',
              transcode_error = '',
              original_size_bytes = $2,
              playback_size_bytes = $3,
              playback_bitrate = $4,
              duration_seconds = COALESCE($5, duration_seconds),
              transcoded_at = now(),
              updated_at = now()
          WHERE id = $6
        `,
        [
          playbackFileUrl,
          originalStat.size,
          playbackStat.size,
          metadata.bitrate,
          metadata.durationSeconds,
          video.id
        ]
      );
    } catch (error) {
      await cleanupFilePath(playbackPath);
      await query(
        `
          UPDATE videos
          SET transcode_status = 'failed',
              transcode_error = $1,
              updated_at = now()
          WHERE id = $2
        `,
        [String(error.message || error).slice(0, 1000), video.id]
      );
      console.error(`[video-transcode] failed videoId=${video.id}`, error);
    }
  }
}

// 服务启动后异步补转历史文件，不阻塞正常页面访问。
function startPendingTranscodeWorker() {
  processPendingTranscodes().catch(function handlePendingTranscodeError(error) {
    console.error("[video-transcode] pending worker failed", error);
  });
}

// 提取被结构变更影响的关联标识。
function mapLinkId(link) {
  return link.id;
}

// 解码请求头里的姓名，支持中文姓名通过 URL 编码传输。
function decodeUserName(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  try {
    return decodeURIComponent(text);
  } catch (_error) {
    return text;
  }
}

// 从请求里读取当前用户姓名。当前版本按用户输入姓名识别角色，不做密码校验。
function getRequestUserName(request) {
  return decodeUserName(request.get("x-user-name") || request.query.name || request.body?.name);
}

// 判断当前姓名是否拥有管理员页面权限。
function isAdminName(name) {
  return normalizeText(name).toLowerCase() === adminUserName;
}

// 保护管理员接口，避免访客和普通上传者直接执行整理操作。
function requireAdmin(request, response, next) {
  if (!isAdminName(getRequestUserName(request))) {
    response.status(403).json({ error: "只有管理员 raccoon 可以访问这个接口" });
    return;
  }
  next();
}

// 获取总览页需要的歌词、视频、统计和待办数据。公开视图只展示已公开并激活的覆盖关系。
async function getOverviewData(options = {}) {
  const publicOnly = options.publicOnly === true;
  const linkStatusCondition = publicOnly
    ? "video_lyric_links.status = 'active'"
    : "video_lyric_links.status IN ('pending', 'active')";
  const videoStatusCondition = publicOnly
    ? "videos.status = 'reviewed' AND videos.transcode_status = 'ready' AND videos.playback_file_url IS NOT NULL"
    : "videos.status NOT IN ('rejected', 'archived')";
  const coverageVideoStatusCondition = publicOnly
    ? "coverage_videos.status = 'reviewed' AND coverage_videos.transcode_status = 'ready' AND coverage_videos.playback_file_url IS NOT NULL"
    : "coverage_videos.status NOT IN ('rejected', 'archived')";
  const statsSql = publicOnly
    ? `
      SELECT
        (SELECT count(*) FROM lyric_units WHERE is_active = true)::int AS lyric_count,
        (SELECT count(*) FROM videos WHERE status NOT IN ('rejected', 'archived') AND transcode_status = 'ready' AND playback_file_url IS NOT NULL)::int AS video_count,
        (SELECT count(DISTINCT person_id) FROM videos WHERE status = 'reviewed' AND transcode_status = 'ready' AND playback_file_url IS NOT NULL)::int AS person_count,
        0::int AS pending_count
    `
    : `
      SELECT
        (SELECT count(*) FROM lyric_units WHERE is_active = true)::int AS lyric_count,
        (SELECT count(*) FROM videos WHERE status NOT IN ('rejected', 'archived'))::int AS video_count,
        (SELECT count(DISTINCT person_id) FROM videos WHERE status NOT IN ('rejected', 'archived'))::int AS person_count,
        (SELECT count(*) FROM relink_tasks WHERE status = 'pending')::int AS pending_count
    `;
  const lyricsPromise = query(`
    SELECT
      lyric_units.id::text,
      lyric_units.order_index,
      lyric_units.text,
      (
        SELECT count(DISTINCT coverage_videos.id)::int
        FROM video_lyric_links AS coverage_links
        JOIN videos AS coverage_videos
          ON coverage_videos.id = coverage_links.video_id
        WHERE coverage_links.lyric_unit_id = lyric_units.id
          AND coverage_links.status IN ('pending', 'active')
          AND ${coverageVideoStatusCondition}
      ) AS video_count,
      COALESCE(
        json_agg(
          json_build_object(
            'linkId', video_lyric_links.id::text,
            'linkStatus', video_lyric_links.status,
            'videoId', videos.id::text,
            'title', videos.original_filename,
            'fileUrl', videos.playback_file_url,
            'originalFileUrl', videos.file_url,
            'playbackFileUrl', videos.playback_file_url,
            'thumbnailUrl', videos.thumbnail_url,
            'videoStatus', videos.status,
            'transcodeStatus', videos.transcode_status,
            'transcodeError', videos.transcode_error,
            'originalSizeBytes', videos.original_size_bytes,
            'playbackSizeBytes', videos.playback_size_bytes,
            'playbackBitrate', videos.playback_bitrate,
            'durationSeconds', videos.duration_seconds,
            'personName', persons.display_name
          )
          ORDER BY videos.created_at
        ) FILTER (WHERE videos.id IS NOT NULL),
        '[]'::json
      ) AS videos
    FROM lyric_units
    LEFT JOIN video_lyric_links
      ON video_lyric_links.lyric_unit_id = lyric_units.id
      AND ${linkStatusCondition}
    LEFT JOIN videos
      ON videos.id = video_lyric_links.video_id
      AND ${videoStatusCondition}
    LEFT JOIN persons
      ON persons.id = videos.person_id
    WHERE lyric_units.is_active = true
    GROUP BY lyric_units.id
    ORDER BY lyric_units.order_index ASC
  `);

  const statsPromise = query(statsSql);

  const pendingVideosPromise = Promise.resolve({ rows: [] });

  const relinkTasksPromise = publicOnly ? Promise.resolve({ rows: [] }) : query(`
    SELECT
      relink_tasks.id::text,
      relink_tasks.video_id::text,
      relink_tasks.previous_link_id::text,
      relink_tasks.old_lyric_text,
      relink_tasks.reason,
      relink_tasks.created_at,
      videos.original_filename,
      videos.file_url,
      persons.display_name AS person_name
    FROM relink_tasks
    JOIN videos ON videos.id = relink_tasks.video_id
    JOIN persons ON persons.id = videos.person_id
    WHERE relink_tasks.status = 'pending'
    ORDER BY relink_tasks.created_at DESC
  `);

  const results = await Promise.all([
    lyricsPromise,
    statsPromise,
    pendingVideosPromise,
    relinkTasksPromise
  ]);

  return {
    lyrics: results[0].rows.map(mapLyricRow),
    stats: {
      lyricCount: results[1].rows[0].lyric_count,
      videoCount: results[1].rows[0].video_count,
      personCount: results[1].rows[0].person_count,
      pendingCount: results[1].rows[0].pending_count
    },
    pendingVideos: results[2].rows,
    relinkTasks: results[3].rows
  };
}

// 获取某个上传者自己的视频列表。
async function getUploaderData(name) {
  const videosPromise = query(
    `
      SELECT
        videos.id::text,
        videos.original_filename,
        videos.file_url,
        videos.playback_file_url,
        videos.transcode_status,
        videos.transcode_error,
        videos.original_size_bytes,
        videos.playback_size_bytes,
        videos.playback_bitrate,
        videos.duration_seconds,
        videos.status,
        videos.created_at,
        videos.updated_at,
        persons.display_name AS person_name,
        COALESCE(
          json_agg(
            json_build_object(
              'linkId', video_lyric_links.id::text,
              'lyricId', lyric_units.id::text,
              'orderIndex', lyric_units.order_index,
              'lyricText', lyric_units.text,
              'status', video_lyric_links.status
            )
            ORDER BY lyric_units.order_index
          ) FILTER (WHERE video_lyric_links.id IS NOT NULL),
          '[]'::json
        ) AS lyric_links
      FROM videos
      JOIN persons ON persons.id = videos.person_id
      LEFT JOIN video_lyric_links ON video_lyric_links.video_id = videos.id
      LEFT JOIN lyric_units ON lyric_units.id = video_lyric_links.lyric_unit_id
      WHERE lower(persons.name) = lower($1)
        OR lower(persons.display_name) = lower($1)
      GROUP BY videos.id, persons.display_name
      ORDER BY videos.created_at DESC
    `,
    [name]
  );

  const statsPromise = query(
    `
      SELECT
        count(*)::int AS total_count,
        count(*) FILTER (WHERE videos.status = 'uploaded')::int AS pending_count,
        count(*) FILTER (WHERE videos.status = 'reviewed')::int AS reviewed_count,
        count(*) FILTER (WHERE videos.status = 'rejected')::int AS rejected_count
      FROM videos
      JOIN persons ON persons.id = videos.person_id
      WHERE lower(persons.name) = lower($1)
        OR lower(persons.display_name) = lower($1)
    `,
    [name]
  );

  const results = await Promise.all([videosPromise, statsPromise]);
  return {
    userName: name,
    videos: results[0].rows,
    stats: {
      totalCount: results[1].rows[0].total_count,
      pendingCount: results[1].rows[0].pending_count,
      reviewedCount: results[1].rows[0].reviewed_count,
      rejectedCount: results[1].rows[0].rejected_count
    }
  };
}

// 获取测试页需要的所有视频，不按审核状态过滤，方便排查真实文件播放问题。
async function getTestVideos() {
  const result = await query(`
    SELECT
      videos.id::text,
      videos.original_filename,
      videos.file_url,
      videos.playback_file_url,
      videos.thumbnail_url,
      videos.status,
      videos.transcode_status,
      videos.transcode_error,
      videos.original_size_bytes,
      videos.playback_size_bytes,
      videos.playback_bitrate,
      videos.duration_seconds,
      videos.created_at,
      videos.updated_at,
      persons.display_name AS person_name,
      COALESCE(
        json_agg(
          json_build_object(
            'linkId', video_lyric_links.id::text,
            'lyricId', lyric_units.id::text,
            'orderIndex', lyric_units.order_index,
            'lyricText', lyric_units.text,
            'status', video_lyric_links.status
          )
          ORDER BY lyric_units.order_index NULLS LAST, video_lyric_links.created_at
        ) FILTER (WHERE video_lyric_links.id IS NOT NULL),
        '[]'::json
      ) AS lyric_links
    FROM videos
    JOIN persons ON persons.id = videos.person_id
    LEFT JOIN video_lyric_links ON video_lyric_links.video_id = videos.id
    LEFT JOIN lyric_units ON lyric_units.id = video_lyric_links.lyric_unit_id
    GROUP BY videos.id, persons.display_name
    ORDER BY videos.created_at DESC
  `);

  return {
    generatedAt: new Date().toISOString(),
    videos: result.rows.map(mapTestVideoRow)
  };
}

// 返回访客总览数据。
async function handleGetPublicOverview(_request, response, next) {
  try {
    response.json(await getOverviewData({ publicOnly: true }));
  } catch (error) {
    next(error);
  }
}

// 返回全量视频测试数据，并禁止浏览器缓存接口结果。
async function handleGetTestVideos(_request, response, next) {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.json(await getTestVideos());
  } catch (error) {
    next(error);
  }
}

// 接收上传测速数据但不落库、不保存文件，用于测客户端到服务器的真实上传带宽。
function handleUploadBandwidthTest(request, response, next) {
  const startedAt = process.hrtime.bigint();
  let bytes = 0;
  let responded = false;

  function buildPayload(status) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const seconds = durationMs / 1000;
    const bytesPerSecond = seconds > 0 ? bytes / seconds : 0;
    const mbps = bytesPerSecond * 8 / 1_000_000;
    return {
      status,
      bytes,
      durationMs: Number(durationMs.toFixed(1)),
      bytesPerSecond: Number(bytesPerSecond.toFixed(1)),
      mbps: Number(mbps.toFixed(3))
    };
  }

  request.on("data", function handleUploadTestChunk(chunk) {
    bytes += chunk.length;
    if (bytes <= maxUploadTestBytes || responded) {
      return;
    }
    responded = true;
    const payload = buildPayload(413);
    logUploadBandwidthTest(request, payload);
    response.status(413).json({
      ...payload,
      error: `上传测速数据超过限制 ${maxUploadTestBytes} bytes`
    });
    request.destroy();
  });

  request.on("end", function handleUploadTestEnd() {
    if (responded) {
      return;
    }
    responded = true;
    const payload = buildPayload(200);
    logUploadBandwidthTest(request, payload);
    response.json(payload);
  });

  request.on("error", function handleUploadTestError(error) {
    if (responded) {
      return;
    }
    responded = true;
    next(error);
  });
}

// 返回管理员总览数据。
async function handleGetAdminOverview(_request, response, next) {
  try {
    response.json(await getOverviewData());
  } catch (error) {
    next(error);
  }
}

// 返回当前上传者自己的视频数据。
async function handleGetUploaderData(request, response, next) {
  try {
    const name = getRequestUserName(request);
    if (!name) {
      response.status(401).json({ error: "请先输入姓名登录" });
      return;
    }
    response.json(await getUploaderData(name));
  } catch (error) {
    next(error);
  }
}

// 解析表单传入的歌词标识列表。
function parseLyricIds(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue;
  }
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) {
    return String(rawValue).split(",");
  }
  return [];
}

// 标准化表单字符串。
function normalizeText(value) {
  return String(value || "").trim();
}

// 查找已有参与者，没有匹配项时创建新参与者。
async function findOrCreatePerson(client, payload) {
  const contact = normalizeText(payload.contact);
  const name = normalizeText(payload.name);
  const note = normalizeText(payload.note);
  const existing = await client.query(
    `
      SELECT *
      FROM persons
      WHERE lower(name) = lower($1)
        AND COALESCE(contact, '') = $2
      LIMIT 1
    `,
    [name, contact]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const inserted = await client.query(
    `
      INSERT INTO persons (name, display_name, contact, note)
      VALUES ($1, $1, NULLIF($2, ''), $3)
      RETURNING *
    `,
    [name, contact, note]
  );
  return inserted.rows[0];
}

// 删除已经落盘但数据库写入失败的上传文件。
async function cleanupUploadedFiles(files) {
  for (let i = 0; i < files.length; i += 1) {
    await cleanupFilePath(files[i].path);
  }
}

// 删除已生成的播放副本。
async function cleanupPreparedVideos(preparedVideos) {
  for (let i = 0; i < preparedVideos.length; i += 1) {
    await cleanupFilePath(preparedVideos[i].playbackPath);
  }
}

// 创建单个视频记录及可选歌词关联；当前上传后直接公开，不再进入审核队列。
async function createVideoWithLinks(client, personId, preparedVideo, lyricIds) {
  const insertedVideo = await client.query(
    `
      INSERT INTO videos (
        person_id,
        file_url,
        playback_file_url,
        original_filename,
        duration_seconds,
        transcode_status,
        transcode_error,
        original_size_bytes,
        playback_size_bytes,
        playback_bitrate,
        status,
        transcoded_at
      )
      VALUES ($1, $2, $3, $4, $5, 'ready', '', $6, $7, $8, 'reviewed', now())
      RETURNING *
    `,
    [
      personId,
      preparedVideo.originalFileUrl,
      preparedVideo.playbackFileUrl,
      preparedVideo.file.originalname,
      preparedVideo.durationSeconds,
      preparedVideo.originalSizeBytes,
      preparedVideo.playbackSizeBytes,
      preparedVideo.playbackBitrate
    ]
  );
  const video = insertedVideo.rows[0];

  for (let i = 0; i < lyricIds.length; i += 1) {
    await client.query(
      `
        INSERT INTO video_lyric_links (video_id, lyric_unit_id, status)
        VALUES ($1, $2, 'active')
      `,
      [video.id, lyricIds[i]]
    );
  }

  return video;
}

// 处理参与者上传视频。
async function handleCreateUpload(request, response, next) {
  const files = request.files || [];
  try {
    const name = normalizeText(request.body.name);
    const lyricIds = parseLyricIds(request.body.lyricIds);

    if (!name) {
      response.status(400).json({ error: "请填写姓名" });
      await cleanupUploadedFiles(files);
      return;
    }

    if (files.length === 0) {
      response.status(400).json({ error: "请至少上传一个视频" });
      return;
    }

    const preparedVideos = [];
    for (let i = 0; i < files.length; i += 1) {
      preparedVideos.push(await prepareUploadedVideo(files[i]));
    }

    // 在事务内同时创建参与者、视频和歌词关联。
    const result = await withTransaction(async function createUploadTransaction(client) {
      const person = await findOrCreatePerson(client, request.body);
      const createdVideos = [];
      for (let i = 0; i < preparedVideos.length; i += 1) {
        const video = await createVideoWithLinks(client, person.id, preparedVideos[i], lyricIds);
        createdVideos.push(video);
      }
      return { person, videos: createdVideos };
    });

    response.status(201).json(result);
  } catch (error) {
    await cleanupUploadedFiles(files);
    await cleanupPreparedVideos(files.map(function mapMissingPreparedVideo(file) {
      return {
        playbackPath: path.join(uploadDir, resolvePlaybackFilename(file.filename))
      };
    }));
    next(error);
  }
}

// 更新单句歌词文字，不触发重新关联。
async function handleUpdateLyric(request, response, next) {
  try {
    const text = normalizeText(request.body.text);

    if (!text) {
      response.status(400).json({ error: "歌词不能为空" });
      return;
    }

    const result = await query(
      `
        UPDATE lyric_units
        SET text = $1,
            updated_at = now()
        WHERE id = $2
          AND is_active = true
        RETURNING id::text, order_index, text
      `,
      [text, request.params.id]
    );

    if (result.rows.length === 0) {
      response.status(404).json({ error: "歌词不存在" });
      return;
    }

    response.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
}

// 将结构编辑文本解析成一行一句的歌词结构。
function parseStructureLines(rawText) {
  const sourceLines = String(rawText || "").split(/\r?\n/);
  const parsed = [];
  for (let i = 0; i < sourceLines.length; i += 1) {
    const line = sourceLines[i].trim();
    if (!line) {
      continue;
    }
    parsed.push({ text: line });
  }
  return parsed;
}

// 创建因为歌词结构变化产生的重新关联任务。
async function createRelinkTasksForStructureChange(client, reason) {
  const impactedLinks = await client.query(`
    SELECT
      video_lyric_links.id,
      video_lyric_links.video_id,
      video_lyric_links.lyric_unit_id,
      lyric_units.text AS old_lyric_text
    FROM video_lyric_links
    JOIN lyric_units ON lyric_units.id = video_lyric_links.lyric_unit_id
    WHERE lyric_units.is_active = true
      AND video_lyric_links.status IN ('pending', 'active')
  `);

  for (let i = 0; i < impactedLinks.rows.length; i += 1) {
    const link = impactedLinks.rows[i];
    await client.query(
      `
        INSERT INTO relink_tasks (
          video_id,
          previous_link_id,
          old_lyric_unit_id,
          old_lyric_text,
          reason
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
      `,
      [link.video_id, link.id, link.lyric_unit_id, link.old_lyric_text, reason]
    );
  }

  await client.query(`
    UPDATE video_lyric_links
    SET status = 'needs_relink',
        updated_at = now()
    WHERE id = ANY($1::uuid[])
  `, [impactedLinks.rows.map(mapLinkId)]);

  return impactedLinks.rowCount;
}

// 整体替换歌词结构，并把旧关联放入 Relink 暂存区。
async function handleReplaceLyricStructure(request, response, next) {
  try {
    const parsedLines = parseStructureLines(request.body.structureText);
    if (parsedLines.length === 0) {
      response.status(400).json({ error: "歌词结构不能为空" });
      return;
    }

    // 在事务内冻结旧歌词、生成 Relink 任务并插入新歌词。
    const result = await withTransaction(async function replaceStructureTransaction(client) {
      const impactedCount = await createRelinkTasksForStructureChange(
        client,
        "歌词结构被整体保存，需要手动重新关联"
      );
      await client.query(`
        UPDATE lyric_units
        SET is_active = false,
            updated_at = now()
        WHERE is_active = true
      `);

      for (let i = 0; i < parsedLines.length; i += 1) {
        await client.query(
          `
            INSERT INTO lyric_units (order_index, text, version)
            VALUES ($1, $2, 1)
          `,
          [i + 1, parsedLines[i].text]
        );
      }

      return { impactedCount, lyricCount: parsedLines.length };
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
}

// 审核通过视频并激活它的待确认歌词关联。
async function handleReviewVideo(request, response, next) {
  try {
    const readiness = await query(
      `
        SELECT transcode_status, playback_file_url
        FROM videos
        WHERE id = $1
      `,
      [request.params.id]
    );
    if (readiness.rows.length === 0) {
      response.status(404).json({ error: "视频不存在" });
      return;
    }
    if (readiness.rows[0].transcode_status !== "ready" || !readiness.rows[0].playback_file_url) {
      response.status(409).json({ error: "视频还未完成低码率转码，不能审核公开" });
      return;
    }

    // 在事务内审核视频并激活它的待确认歌词关联。
    const result = await withTransaction(async function reviewVideoTransaction(client) {
      const video = await client.query(
        `
          UPDATE videos
          SET status = 'reviewed',
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [request.params.id]
      );

      await client.query(
        `
          UPDATE video_lyric_links
          SET status = 'active',
              updated_at = now()
          WHERE video_id = $1
            AND status = 'pending'
        `,
        [request.params.id]
      );

      return video.rows[0] || null;
    });

    if (!result) {
      response.status(404).json({ error: "视频不存在" });
      return;
    }

    response.json(result);
  } catch (error) {
    next(error);
  }
}

// 驳回不可用的视频素材。
async function handleRejectVideo(request, response, next) {
  try {
    const result = await query(
      `
        UPDATE videos
        SET status = 'rejected',
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [request.params.id]
    );

    if (result.rows.length === 0) {
      response.status(404).json({ error: "视频不存在" });
      return;
    }

    response.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
}

// 管理员删除视频采用归档方式，避免误删原始文件和播放副本。
async function handleDeleteVideo(request, response, next) {
  try {
    const result = await withTransaction(async function deleteVideoTransaction(client) {
      const video = await client.query(
        `
          UPDATE videos
          SET status = 'archived',
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [request.params.id]
      );

      if (video.rows.length === 0) {
        return null;
      }

      await client.query(
        `
          UPDATE video_lyric_links
          SET status = 'archived',
              updated_at = now()
          WHERE video_id = $1
            AND status <> 'archived'
        `,
        [request.params.id]
      );

      return video.rows[0];
    });

    if (!result) {
      response.status(404).json({ error: "视频不存在" });
      return;
    }

    response.json(result);
  } catch (error) {
    next(error);
  }
}

// 将 Relink 任务重新关联到新的歌词句子。
async function handleResolveRelinkTask(request, response, next) {
  try {
    const newLyricId = normalizeText(request.body.lyricId);
    if (!newLyricId) {
      response.status(400).json({ error: "请选择新的歌词句子" });
      return;
    }

    // 在事务内归档旧关联、创建新关联并完成 Relink 任务。
    const result = await withTransaction(async function resolveRelinkTransaction(client) {
      const taskResult = await client.query(
        `
          SELECT *
          FROM relink_tasks
          WHERE id = $1
            AND status = 'pending'
          FOR UPDATE
        `,
        [request.params.id]
      );

      if (taskResult.rows.length === 0) {
        return null;
      }

      const task = taskResult.rows[0];
      await client.query(
        `
          UPDATE video_lyric_links
          SET status = 'archived',
              updated_at = now()
          WHERE id = $1
        `,
        [task.previous_link_id]
      );

      await client.query(
        `
          INSERT INTO video_lyric_links (video_id, lyric_unit_id, status)
          VALUES ($1, $2, 'active')
        `,
        [task.video_id, newLyricId]
      );

      await client.query(
        `
          UPDATE relink_tasks
          SET status = 'resolved',
              updated_at = now()
          WHERE id = $1
        `,
        [task.id]
      );

      return task;
    });

    if (!result) {
      response.status(404).json({ error: "Relink 任务不存在" });
      return;
    }

    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

// 忽略不再需要处理的 Relink 任务。
async function handleIgnoreRelinkTask(request, response, next) {
  try {
    const result = await query(
      `
        UPDATE relink_tasks
        SET status = 'ignored',
            updated_at = now()
        WHERE id = $1
          AND status = 'pending'
        RETURNING *
      `,
      [request.params.id]
    );

    if (result.rows.length === 0) {
      response.status(404).json({ error: "Relink 任务不存在" });
      return;
    }

    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

// 返回前端入口文件，支持刷新后仍然进入单页应用。
function handleIndexFallback(_request, response) {
  response.sendFile(path.join(publicDir, "index.html"));
}

// 返回独立视频播放测试页，避免复用主应用的延迟加载策略。
function handleTestPage(_request, response) {
  response.sendFile(path.join(publicDir, "test.html"));
}

// 处理未匹配到的 API 请求。
function handleApiNotFound(_request, response) {
  response.status(404).json({ error: "接口不存在" });
}

// 统一处理 API 错误。
function handleError(error, _request, response, _next) {
  console.error(error);
  response.status(500).json({ error: "服务器内部错误" });
}

// 输出服务启动地址。
function logServerStart() {
  console.log(`MyVlog server listening on http://127.0.0.1:${port}`);
}

// 在收到终止信号时关闭数据库连接并退出。
async function handleSigterm() {
  await pool.end();
  process.exit(0);
}

app.get("/api/overview", handleGetPublicOverview);
app.get("/api/test/videos", handleGetTestVideos);
app.post("/api/test/upload-bandwidth", handleUploadBandwidthTest);
app.get("/api/uploader/me", handleGetUploaderData);
app.get("/api/admin/overview", requireAdmin, handleGetAdminOverview);
app.post("/api/uploads", upload.array("videos", 8), handleCreateUpload);
app.put("/api/admin/lyrics/structure", requireAdmin, handleReplaceLyricStructure);
app.patch("/api/admin/lyrics/:id", requireAdmin, handleUpdateLyric);
app.post("/api/admin/videos/:id/review", requireAdmin, handleReviewVideo);
app.post("/api/admin/videos/:id/reject", requireAdmin, handleRejectVideo);
app.delete("/api/admin/videos/:id", requireAdmin, handleDeleteVideo);
app.post("/api/admin/relink-tasks/:id/resolve", requireAdmin, handleResolveRelinkTask);
app.post("/api/admin/relink-tasks/:id/ignore", requireAdmin, handleIgnoreRelinkTask);
app.put("/api/lyrics/structure", requireAdmin, handleReplaceLyricStructure);
app.patch("/api/lyrics/:id", requireAdmin, handleUpdateLyric);
app.post("/api/videos/:id/review", requireAdmin, handleReviewVideo);
app.post("/api/videos/:id/reject", requireAdmin, handleRejectVideo);
app.delete("/api/videos/:id", requireAdmin, handleDeleteVideo);
app.post("/api/relink-tasks/:id/resolve", requireAdmin, handleResolveRelinkTask);
app.post("/api/relink-tasks/:id/ignore", requireAdmin, handleIgnoreRelinkTask);
app.use("/api", handleApiNotFound);
app.get("/test", handleTestPage);
app.get("*", handleIndexFallback);
app.use(handleError);

app.listen(port, function handleListen() {
  logServerStart();
  startPendingTranscodeWorker();
});

process.on("SIGTERM", handleSigterm);
