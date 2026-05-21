const testState = {
  cacheToken: createCacheToken(),
  videos: [],
  players: []
};

const playbackEvents = [
  "loadstart",
  "loadedmetadata",
  "canplay",
  "playing",
  "waiting",
  "stalled",
  "suspend",
  "progress",
  "error",
  "ended"
];

const videoStatusText = {
  uploaded: "待整理",
  reviewed: "已公开",
  rejected: "已驳回",
  archived: "已归档"
};

const linkStatusText = {
  pending: "待确认",
  active: "已确认",
  needs_relink: "需重关联",
  archived: "已归档"
};

// 为本轮测试生成短缓存戳，方便在服务端日志里识别同一次打开。
function createCacheToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 根据选择器获取页面元素。
function find(selector) {
  return document.querySelector(selector);
}

// 转义页面展示文本。
function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// 把 TimeRanges 转成可读字符串。
function formatBufferedRanges(ranges) {
  if (!ranges || ranges.length === 0) {
    return "-";
  }
  const parts = [];
  for (let i = 0; i < ranges.length; i += 1) {
    parts.push(`${ranges.start(i).toFixed(2)}-${ranges.end(i).toFixed(2)}`);
  }
  return parts.join(",");
}

// 提取媒体错误细节。
function getVideoError(video) {
  if (!video.error) {
    return null;
  }
  return {
    code: video.error.code,
    message: video.error.message || "-"
  };
}

// 生成带缓存戳的视频地址，让每轮测试都触发新的静态资源请求。
function buildCacheBustedUrl(fileUrl) {
  const url = new URL(fileUrl, window.location.origin);
  url.searchParams.set("testSession", testState.cacheToken);
  return `${url.pathname}${url.search}${url.hash}`;
}

// 记录页面和控制台都能看到的播放事件。
function appendLog(type, payload) {
  const entry = {
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    type,
    ...payload
  };
  const line = JSON.stringify(entry);
  const log = find("#eventLog");
  log.textContent = `${line}\n${log.textContent}`.slice(0, 60000);
  if (type === "waiting" || type === "stalled" || type === "error") {
    console.warn("[test-video]", line);
    return;
  }
  console.info("[test-video]", line);
}

// 记录原生 video 元素的关键状态，便于和服务端 Range 日志对照。
function handlePlaybackEvent(event) {
  const video = event.currentTarget;
  appendLog(event.type, {
    videoId: video.dataset.videoId || "-",
    title: video.dataset.videoTitle || "-",
    currentTime: video.currentTime.toFixed(2),
    duration: Number.isFinite(video.duration) ? video.duration.toFixed(2) : "-",
    readyState: video.readyState,
    networkState: video.networkState,
    buffered: formatBufferedRanges(video.buffered),
    currentSrc: video.currentSrc || "-",
    error: getVideoError(video)
  });
}

// 避免多个测试视频同时播放导致带宽判断混乱。
function pauseOtherVideos(currentVideo) {
  const videos = document.querySelectorAll("video[data-test-video]");
  for (let i = 0; i < videos.length; i += 1) {
    if (videos[i] !== currentVideo && !videos[i].paused) {
      videos[i].pause();
    }
  }
}

// 格式化服务端时间。
function formatDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

// 渲染视频关联的歌词摘要。
function renderLyricLinks(links) {
  if (!links || links.length === 0) {
    return '<div class="test-link-line">未关联歌词</div>';
  }
  let html = "";
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    const order = link.orderIndex || "-";
    const status = linkStatusText[link.status] || link.status || "-";
    html += `
      <div class="test-link-line">
        ${escapeHtml(order)}. ${escapeHtml(link.lyricText || "歌词已停用")} · ${escapeHtml(status)}
      </div>
    `;
  }
  return html;
}

// 渲染单个测试视频卡片。
function renderVideoCard(video) {
  const src = buildCacheBustedUrl(video.fileUrl);
  const statusText = videoStatusText[video.status] || video.status || "-";
  return `
    <article class="test-video-card">
      <div class="test-player-wrap">
        <video
          id="test-video-${escapeHtml(video.id)}"
          class="video-js vjs-default-skin vjs-big-play-centered"
          controls
          playsinline
          preload="metadata"
          data-test-video
          data-video-id="${escapeHtml(video.id)}"
          data-video-title="${escapeHtml(video.title)}"
          src="${escapeHtml(src)}"
        ></video>
      </div>
      <div class="test-video-meta">
        <div class="test-video-title">
          <h2>${escapeHtml(video.title)}</h2>
          <span class="badge ${video.status === "reviewed" ? "good" : "warn"}">${escapeHtml(statusText)}</span>
        </div>
        <div class="test-meta-grid">
          <span>上传者：${escapeHtml(video.personName || "-")}</span>
          <span>创建时间：${escapeHtml(formatDate(video.createdAt))}</span>
          <span>文件地址：${escapeHtml(video.fileUrl)}</span>
          <a class="button test-file-link" href="${escapeHtml(src)}" target="_blank" rel="noreferrer">打开原文件</a>
        </div>
        <div class="test-lyric-links">${renderLyricLinks(video.lyricLinks)}</div>
      </div>
    </article>
  `;
}

// 销毁上一轮 Video.js 播放器实例，避免刷新测试时重复绑定。
function disposePlayers() {
  for (let i = 0; i < testState.players.length; i += 1) {
    testState.players[i].dispose();
  }
  testState.players = [];
}

// 给视频元素绑定原生日志和 Video.js 播放器。
function bindPlayers() {
  const hasVideoJs = typeof window.videojs === "function";
  find("#playerStatus").textContent = hasVideoJs
    ? "Video.js 已启用"
    : "Video.js 未加载，已使用原生播放器";

  const videos = document.querySelectorAll("video[data-test-video]");
  for (let i = 0; i < videos.length; i += 1) {
    const video = videos[i];
    video.addEventListener("play", function handlePlay() {
      pauseOtherVideos(video);
    });
    for (let j = 0; j < playbackEvents.length; j += 1) {
      video.addEventListener(playbackEvents[j], handlePlaybackEvent);
    }
    if (hasVideoJs) {
      const player = window.videojs(video, {
        controls: true,
        fluid: true,
        preload: "metadata"
      });
      player.ready(function handlePlayerReady() {
        appendLog("player-ready", {
          videoId: video.dataset.videoId || "-",
          title: video.dataset.videoTitle || "-"
        });
      });
      testState.players.push(player);
    }
  }
}

// 渲染当前视频列表。
function renderVideos() {
  find("#cacheToken").textContent = testState.cacheToken;
  find("#testSummary").textContent = `${testState.videos.length} 个视频 · 接口和视频地址都带本轮缓存戳`;
  let html = "";
  for (let i = 0; i < testState.videos.length; i += 1) {
    html += renderVideoCard(testState.videos[i]);
  }
  find("#videoList").innerHTML = html || '<div class="queue-item"><strong>暂无视频</strong><p>数据库里还没有视频记录。</p></div>';
  bindPlayers();
}

// 加载全量视频测试数据。
async function loadVideos() {
  const response = await fetch(`/api/test/videos?testSession=${encodeURIComponent(testState.cacheToken)}`, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache"
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "视频测试数据加载失败");
  }
  testState.videos = payload.videos || [];
  renderVideos();
  appendLog("api-loaded", {
    count: testState.videos.length,
    generatedAt: payload.generatedAt
  });
}

// 刷新缓存戳并重新挂载所有播放器。
async function reloadTest() {
  disposePlayers();
  testState.cacheToken = createCacheToken();
  find("#cacheToken").textContent = testState.cacheToken;
  find("#testSummary").textContent = "正在加载视频...";
  find("#videoList").innerHTML = "";
  try {
    await loadVideos();
  } catch (error) {
    find("#testSummary").textContent = `加载失败：${error.message}`;
    appendLog("api-error", { message: error.message });
  }
}

// 绑定测试页按钮。
function bindEvents() {
  find("#reloadButton").addEventListener("click", reloadTest);
  find("#clearLogButton").addEventListener("click", function clearLog() {
    find("#eventLog").textContent = "";
  });
}

// 初始化测试页面。
async function initTestPage() {
  bindEvents();
  await reloadTest();
}

document.addEventListener("DOMContentLoaded", initTestPage);
