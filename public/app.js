const ADMIN_NAME = "raccoon";
const SESSION_KEY = "myvlog.sessionName";
const METRONOME_MIN_BPM = 40;
const METRONOME_MAX_BPM = 220;
const METRONOME_DEFAULT_BPM = 90;
const METRONOME_DEFAULT_BEATS = 4;

const state = {
  view: resolveView(),
  sessionName: readSessionName(),
  lyrics: [],
  stats: {
    lyricCount: 0,
    videoCount: 0,
    personCount: 0,
    pendingCount: 0
  },
  pendingVideos: [],
  relinkTasks: [],
  uploaderVideos: [],
  uploaderStats: {
    totalCount: 0,
    pendingCount: 0,
    reviewedCount: 0,
    rejectedCount: 0
  },
  activeLyricId: null,
  expandedUploaderLyricId: null,
  uploadSelectionMode: false,
  uploadLyricIds: [],
  metronome: {
    bpm: METRONOME_DEFAULT_BPM,
    beatsPerBar: METRONOME_DEFAULT_BEATS,
    currentBeat: 0,
    running: false,
    intervalId: null,
    audioContext: null,
    tapTimes: [],
    status: "准备就绪"
  }
};

let videoPreviewObserver = null;

const videoPlaybackLogEvents = [
  "loadstart",
  "loadedmetadata",
  "canplay",
  "playing",
  "waiting",
  "stalled",
  "suspend",
  "error",
  "ended"
];

const videoStatusLabels = {
  uploaded: "待整理",
  reviewed: "已公开",
  rejected: "已驳回",
  archived: "已归档"
};

const linkStatusLabels = {
  pending: "待确认",
  active: "已确认",
  needs_relink: "需重关联",
  archived: "已归档"
};

const transcodeStatusLabels = {
  pending: "等待转码",
  processing: "转码中",
  ready: "可播放",
  failed: "转码失败"
};

// 根据当前路径判断页面角色。
function resolveView() {
  const normalized = window.location.pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/uploader") {
    return "uploader";
  }
  if (normalized === "/admin") {
    return "admin";
  }
  return "visitor";
}

// 读取本机保存的姓名，作为无密码登录凭据。
function readSessionName() {
  return normalizeText(window.localStorage.getItem(SESSION_KEY));
}

// 标准化页面输入文本。
function normalizeText(value) {
  return String(value || "").trim();
}

// 根据选择器获取单个页面元素。
function find(selector) {
  return document.querySelector(selector);
}

// 根据选择器获取多个页面元素。
function findAll(selector) {
  return document.querySelectorAll(selector);
}

// 转义 HTML 字符，避免数据内容破坏页面结构。
function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// 判断当前姓名是否是管理员姓名。
function isAdminSession() {
  return normalizeText(state.sessionName).toLowerCase() === ADMIN_NAME;
}

// 把节拍器速度限制在录制时常用且浏览器定时器稳定的范围内。
function clampMetronomeBpm(value) {
  const bpm = Math.round(Number(value));
  if (!Number.isFinite(bpm)) {
    return state.metronome.bpm;
  }
  return Math.min(METRONOME_MAX_BPM, Math.max(METRONOME_MIN_BPM, bpm));
}

// 根据当前 BPM 计算每拍间隔。
function getMetronomeIntervalMs() {
  return 60000 / state.metronome.bpm;
}

// 初始化浏览器音频上下文，必须由管理员点击按钮后触发。
async function ensureMetronomeAudioContext() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("当前浏览器不支持网页音频。");
  }
  if (!state.metronome.audioContext) {
    state.metronome.audioContext = new AudioContextConstructor();
  }
  if (state.metronome.audioContext.state === "suspended") {
    await state.metronome.audioContext.resume();
  }
}

// 播放一个短促节拍音，第一拍使用更高音量和频率作为重拍。
function playMetronomeTick(beatNumber) {
  const context = state.metronome.audioContext;
  if (!context) {
    return;
  }

  const now = context.currentTime;
  const accented = beatNumber === 1;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(accented ? 1320 : 880, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(accented ? 0.26 : 0.18, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.09);
}

// 重新创建定时器，让运行中的节拍器立刻响应速度变化。
function restartMetronomeTimer() {
  if (!state.metronome.running) {
    return;
  }
  window.clearInterval(state.metronome.intervalId);
  state.metronome.intervalId = window.setInterval(runMetronomeBeat, getMetronomeIntervalMs());
}

// 推进下一拍并刷新可视化状态。
function runMetronomeBeat() {
  if (!state.metronome.running) {
    return;
  }
  state.metronome.currentBeat = (state.metronome.currentBeat % state.metronome.beatsPerBar) + 1;
  playMetronomeTick(state.metronome.currentBeat);
  renderMetronome();
}

// 启动管理员页节拍器。
async function startMetronome() {
  await ensureMetronomeAudioContext();
  if (state.metronome.running) {
    return;
  }
  state.metronome.running = true;
  state.metronome.currentBeat = 0;
  state.metronome.status = "播放中";
  runMetronomeBeat();
  restartMetronomeTimer();
  renderMetronome();
}

// 停止管理员页节拍器并清理定时器。
function stopMetronome() {
  window.clearInterval(state.metronome.intervalId);
  state.metronome.intervalId = null;
  state.metronome.running = false;
  state.metronome.currentBeat = 0;
  state.metronome.status = "已停止";
  renderMetronome();
}

// 切换节拍器播放状态。
async function toggleMetronome() {
  if (state.metronome.running) {
    stopMetronome();
    return;
  }
  await startMetronome();
}

// 设置节拍器速度，并同步数字输入、滑杆和运行中的定时器。
function setMetronomeBpm(value, statusText) {
  const bpm = clampMetronomeBpm(value);
  state.metronome.bpm = bpm;
  state.metronome.status = statusText || `速度 ${bpm} BPM`;
  restartMetronomeTimer();
  renderMetronome();
}

// 设置每小节拍数，超过新范围的当前拍会从下一拍重新开始。
function setMetronomeBeats(value) {
  const beatsPerBar = Number(value);
  state.metronome.beatsPerBar = [2, 3, 4, 6].includes(beatsPerBar)
    ? beatsPerBar
    : METRONOME_DEFAULT_BEATS;
  if (state.metronome.currentBeat > state.metronome.beatsPerBar) {
    state.metronome.currentBeat = 0;
  }
  state.metronome.status = `${state.metronome.beatsPerBar} 拍循环`;
  renderMetronome();
}

// 根据连续敲击间隔估算 BPM，方便管理员跟着参考音频快速定速。
function tapMetronomeTempo() {
  const now = window.performance.now();
  state.metronome.tapTimes = state.metronome.tapTimes
    .filter(function keepRecentTap(time) {
      return now - time < 2500;
    })
    .slice(-5);
  state.metronome.tapTimes.push(now);

  if (state.metronome.tapTimes.length < 2) {
    state.metronome.status = "再敲一次设置速度";
    renderMetronome();
    return;
  }

  const intervals = [];
  for (let i = 1; i < state.metronome.tapTimes.length; i += 1) {
    intervals.push(state.metronome.tapTimes[i] - state.metronome.tapTimes[i - 1]);
  }
  const averageInterval = intervals.reduce(function sum(total, interval) {
    return total + interval;
  }, 0) / intervals.length;
  const bpm = clampMetronomeBpm(60000 / averageInterval);
  setMetronomeBpm(bpm, `已按敲击速度设为 ${bpm} BPM`);
}

// 渲染节拍器的控制值、当前拍和状态文案。
function renderMetronome() {
  const bpmInput = find("#metronomeBpmInput");
  if (!bpmInput) {
    return;
  }

  const metronome = state.metronome;
  if (document.activeElement !== bpmInput) {
    bpmInput.value = metronome.bpm;
  }
  find("#metronomeBpmRange").value = metronome.bpm;
  find("#metronomeBeatsInput").value = metronome.beatsPerBar;
  find("#metronomeTempoLabel").textContent = `${metronome.bpm} BPM`;
  find("#metronomeToggle").textContent = metronome.running ? "停止" : "开始";
  find("#metronomeBeatLabel").textContent = metronome.running
    ? `${metronome.currentBeat || 1} / ${metronome.beatsPerBar}`
    : "准备";
  find("#metronomeStatus").textContent = metronome.status;

  let dots = "";
  for (let beat = 1; beat <= metronome.beatsPerBar; beat += 1) {
    const classes = [
      "beat-dot",
      beat === 1 ? "accent" : "",
      metronome.running && beat === metronome.currentBeat ? "active" : ""
    ].filter(Boolean).join(" ");
    dots += `<span class="${classes}"></span>`;
  }
  find("#metronomeBeatDots").innerHTML = dots;
}

// 把 TimeRanges 转成紧凑字符串，便于排查卡顿时是否已经缓冲到当前位置。
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

// 提取媒体错误细节，避免控制台只显示不可展开的 MediaError 对象。
function getVideoError(video) {
  if (!video.error) {
    return null;
  }
  return {
    code: video.error.code,
    message: video.error.message || "-"
  };
}

// 在用户即将播放或视频进入视口时再挂载 src，减少列表页并发预加载。
function activateVideoPreview(video, reason) {
  if (video.dataset.loaded === "true") {
    return;
  }
  const source = video.dataset.src;
  if (!source) {
    return;
  }
  video.src = source;
  video.dataset.loaded = "true";
  console.info("[video-preview]", JSON.stringify({
    event: "source-attached",
    reason,
    videoId: video.dataset.videoId || "-",
    title: video.dataset.videoTitle || "-",
    source
  }));
}

// 同一页面只保留一个视频播放，避免多个视频同时占用服务器带宽。
function pauseOtherVideos(currentVideo) {
  const videos = document.querySelectorAll("video[data-video-preview]");
  for (let i = 0; i < videos.length; i += 1) {
    if (videos[i] !== currentVideo && !videos[i].paused) {
      videos[i].pause();
    }
  }
}

// 输出浏览器侧视频播放状态，服务器测试时可对照后端 Range 日志。
function logVideoPlaybackEvent(event) {
  const video = event.currentTarget;
  const payload = {
    event: event.type,
    videoId: video.dataset.videoId || "-",
    title: video.dataset.videoTitle || "-",
    currentTime: video.currentTime.toFixed(2),
    duration: Number.isFinite(video.duration) ? video.duration.toFixed(2) : "-",
    readyState: video.readyState,
    networkState: video.networkState,
    buffered: formatBufferedRanges(video.buffered),
    loaded: video.dataset.loaded === "true",
    currentSrc: video.currentSrc || "-",
    canPlayMp4: video.canPlayType("video/mp4"),
    canPlayQuickTime: video.canPlayType("video/quicktime"),
    error: getVideoError(video)
  };
  if (event.type === "waiting" || event.type === "stalled" || event.type === "error") {
    console.warn("[video-preview]", JSON.stringify(payload));
    return;
  }
  console.info("[video-preview]", JSON.stringify(payload));
}

// 绑定单个视频预览的延迟加载和诊断日志。
function bindVideoPreview(video) {
  if (video.dataset.bound === "true") {
    return;
  }
  video.dataset.bound = "true";
  video.addEventListener("pointerenter", function handleVideoPointerEnter() {
    activateVideoPreview(video, "pointerenter");
  }, { once: true });
  video.addEventListener("pointerdown", function handleVideoPointerDown() {
    activateVideoPreview(video, "pointerdown");
  });
  video.addEventListener("touchstart", function handleVideoTouchStart() {
    activateVideoPreview(video, "touchstart");
  }, { passive: true, once: true });
  video.addEventListener("focus", function handleVideoFocus() {
    activateVideoPreview(video, "focus");
  }, { once: true });
  video.addEventListener("play", function handleVideoPlay() {
    activateVideoPreview(video, "play");
    pauseOtherVideos(video);
  });
  for (let i = 0; i < videoPlaybackLogEvents.length; i += 1) {
    video.addEventListener(videoPlaybackLogEvents[i], logVideoPlaybackEvent);
  }
}

// 视口附近的视频才挂载 src，避免一次性触发所有视频文件请求。
function observeVideoPreview(video) {
  if (!("IntersectionObserver" in window)) {
    activateVideoPreview(video, "no-intersection-observer");
    return;
  }
  if (!videoPreviewObserver) {
    videoPreviewObserver = new IntersectionObserver(function handleVideoIntersection(entries) {
      for (let i = 0; i < entries.length; i += 1) {
        if (entries[i].isIntersecting) {
          activateVideoPreview(entries[i].target, "intersection");
          videoPreviewObserver.unobserve(entries[i].target);
        }
      }
    }, {
      rootMargin: "240px 0px",
      threshold: 0.01
    });
  }
  videoPreviewObserver.observe(video);
}

// 每次重新渲染视频列表后，重新接管当前 DOM 中的视频预览。
function prepareVideoPreviews() {
  const videos = document.querySelectorAll("video[data-video-preview]");
  for (let i = 0; i < videos.length; i += 1) {
    bindVideoPreview(videos[i]);
    observeVideoPreview(videos[i]);
  }
}

// 构造带当前姓名的请求参数。
function withUserHeaders(options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.sessionName) {
    headers.set("X-User-Name", encodeURIComponent(state.sessionName));
  }
  return {
    ...options,
    headers
  };
}

// 向后端请求 JSON 数据。
async function requestJson(url, options) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  let payload = null;
  if (contentType.includes("application/json")) {
    payload = await response.json();
  }
  if (!response.ok) {
    const message = payload && payload.error ? payload.error : "请求失败";
    throw new Error(message);
  }
  return payload;
}

// 按标识查找歌词。
function getLyricById(id) {
  for (let i = 0; i < state.lyrics.length; i += 1) {
    if (state.lyrics[i].id === id) {
      return state.lyrics[i];
    }
  }
  return null;
}

// 按顺序号查找歌词。
function getLyricByOrder(orderIndex) {
  for (let i = 0; i < state.lyrics.length; i += 1) {
    if (state.lyrics[i].orderIndex === orderIndex) {
      return state.lyrics[i];
    }
  }
  return null;
}

// 让当前选中歌词保持在最新数据中。
function normalizeActiveLyric() {
  if (!state.activeLyricId && state.lyrics.length > 0) {
    state.activeLyricId = state.lyrics[0].id;
  }

  if (state.activeLyricId && !getLyricById(state.activeLyricId) && state.lyrics.length > 0) {
    state.activeLyricId = state.lyrics[0].id;
  }
}

// 应用后端返回的总览数据。
function applyOverviewData(data) {
  state.lyrics = data.lyrics || [];
  state.stats = data.stats || state.stats;
  state.pendingVideos = data.pendingVideos || [];
  state.relinkTasks = data.relinkTasks || [];
  normalizeActiveLyric();
}

// 加载访客可见的公开总览数据。
async function loadPublicOverview() {
  applyOverviewData(await requestJson("/api/overview"));
}

// 加载管理员后台数据。
async function loadAdminOverview() {
  applyOverviewData(await requestJson("/api/admin/overview", withUserHeaders()));
}

// 加载当前上传者自己的视频。
async function loadUploaderData() {
  if (!state.sessionName) {
    state.uploaderVideos = [];
    state.uploaderStats = {
      totalCount: 0,
      pendingCount: 0,
      reviewedCount: 0,
      rejectedCount: 0
    };
    return;
  }
  const data = await requestJson("/api/uploader/me", withUserHeaders());
  state.uploaderVideos = data.videos || [];
  state.uploaderStats = data.stats || state.uploaderStats;
}

// 加载当前路由需要的数据。
async function loadCurrentView() {
  state.view = resolveView();
  if (state.view === "admin") {
    if (isAdminSession()) {
      await loadAdminOverview();
    }
    return;
  }

  await loadPublicOverview();
  if (state.view === "uploader" && state.sessionName) {
    await loadUploaderData();
  }
}

// 刷新当前页面。
async function refreshCurrentView() {
  renderShell();
  try {
    await loadCurrentView();
    renderAll();
  } catch (error) {
    renderAll();
    renderPageError(error);
  }
}

// 渲染整体外壳、导航和姓名状态。
function renderShell() {
  document.body.dataset.view = state.view;
  document.body.classList.toggle("mobile-role-view", state.view !== "admin");

  const pages = findAll("[data-page]");
  for (let i = 0; i < pages.length; i += 1) {
    pages[i].hidden = pages[i].dataset.page !== state.view;
  }

  const navItems = findAll("[data-nav-view]");
  for (let i = 0; i < navItems.length; i += 1) {
    navItems[i].classList.toggle("active", navItems[i].dataset.navView === state.view);
  }

  find("#sessionName").textContent = state.sessionName || "未登录";
  find("#navLyricCount").textContent = state.stats.lyricCount;
  find("#navUploaderCount").textContent = state.uploaderStats.totalCount;
  find("#navPendingCount").textContent = state.stats.pendingCount;

  find("#uploaderNameInput").value = state.sessionName;
  find("#adminNameInput").value = state.sessionName;
  find("#quickLoginName").value = state.sessionName;
}

// 渲染所有当前页面区域。
function renderAll() {
  renderShell();
  if (state.view === "visitor") {
    renderVisitorPage();
  } else if (state.view === "uploader") {
    renderUploaderPage();
  } else if (state.view === "admin") {
    renderAdminPage();
  }
  prepareVideoPreviews();
}

// 统计某句歌词的覆盖数量；访客页只展示后端返回的公开可播放素材。
function countVideosForLyric(lyric) {
  const count = Number(lyric.videoCount);
  if (Number.isFinite(count)) {
    return count;
  }
  return lyric.videos ? lyric.videos.length : 0;
}

// 统计还没有公开覆盖的视频句子数。
function countMissingLyrics() {
  let count = 0;
  for (let i = 0; i < state.lyrics.length; i += 1) {
    if (countVideosForLyric(state.lyrics[i]) === 0) {
      count += 1;
    }
  }
  return count;
}

// 取出当前上传者在某句歌词下的视频和对应关联。
function getUploaderVideosForLyric(lyricId) {
  const matches = [];
  for (let i = 0; i < state.uploaderVideos.length; i += 1) {
    const video = state.uploaderVideos[i];
    if (!isVisibleUploaderVideo(video)) {
      continue;
    }
    const links = video.lyric_links || [];
    for (let j = 0; j < links.length; j += 1) {
      if (links[j].lyricId === lyricId) {
        matches.push({ video, link: links[j] });
      }
    }
  }
  return matches;
}

// 删除或驳回后的视频不再出现在上传者自己的页面。
function isVisibleUploaderVideo(video) {
  return video.status !== "rejected" && video.status !== "archived";
}

// 统计上传者自己页面可见的视频数量。
function countVisibleUploaderVideos() {
  let count = 0;
  for (let i = 0; i < state.uploaderVideos.length; i += 1) {
    if (isVisibleUploaderVideo(state.uploaderVideos[i])) {
      count += 1;
    }
  }
  return count;
}

// 判断当前歌词是否已加入本次上传前的歌词选择。
function isUploadLyricSelected(lyricId) {
  return state.uploadLyricIds.includes(lyricId);
}

// 读取本次上传前在主页歌词列表中选中的歌词。
function getSelectedUploadLyrics() {
  const lyrics = [];
  for (let i = 0; i < state.lyrics.length; i += 1) {
    if (isUploadLyricSelected(state.lyrics[i].id)) {
      lyrics.push(state.lyrics[i]);
    }
  }
  return lyrics;
}

// 清空上传前选择态，避免下次上传沿用旧歌词。
function resetUploadSelection() {
  state.uploadSelectionMode = false;
  state.uploadLyricIds = [];
}

// 按状态返回徽标样式。
function getStatusClass(status) {
  if (status === "reviewed" || status === "active" || status === "ready") {
    return "good";
  }
  if (status === "rejected" || status === "archived" || status === "failed") {
    return "danger";
  }
  return "warn";
}

// 判断视频是否已有低码率播放副本。
function isVideoPlayable(video) {
  const status = video.transcodeStatus || video.transcode_status;
  return status === "ready" && Boolean(getVideoPlaybackUrl(video));
}

// 取出前端真正允许播放的视频地址，只使用低码率副本。
function getVideoPlaybackUrl(video) {
  const explicit = video.playbackFileUrl || video.playback_file_url;
  if (explicit) {
    return explicit;
  }
  if (video.transcodeStatus === "ready") {
    return video.fileUrl || "";
  }
  return "";
}

// 渲染未转码视频的占位状态，避免页面直接播放原始上传文件。
function renderVideoUnavailable(video) {
  const status = video.transcodeStatus || video.transcode_status || "pending";
  const label = transcodeStatusLabels[status] || status;
  const error = video.transcodeError || video.transcode_error || "";
  return `
    <div class="video-unavailable">
      <span class="badge ${getStatusClass(status)}">${escapeHtml(label)}</span>
      <p>${escapeHtml(error || "播放副本生成完成后才允许播放。")}</p>
    </div>
  `;
}

// 格式化服务端时间。
function formatDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

// 渲染单行歌词按钮。
function renderLyricRow(lyric) {
  const count = countVideosForLyric(lyric);
  const activeClass = lyric.id === state.activeLyricId ? " active" : "";
  const badgeClass = count > 0 ? "good" : "warn";
  const badgeText = count > 0 ? "已覆盖" : "缺素材";
  return `
    <button type="button" class="lyric-row${activeClass}" data-action="select-lyric" data-id="${escapeHtml(lyric.id)}">
      <span class="lyric-index">${escapeHtml(lyric.orderIndex)}</span>
      <span class="lyric-main">
        <span class="lyric-text">${escapeHtml(lyric.text)}</span>
        <span class="meta-line">
          <span>${count} 个视频</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </span>
      </span>
    </button>
  `;
}

// 渲染访客移动端歌词行，只保留公开视频数量。
function renderVisitorLyricRow(lyric) {
  const count = countVideosForLyric(lyric);
  const countClass = count === 0 ? " zero" : "";
  return `
    <div class="mobile-lyric-row">
      <span class="mobile-index">${escapeHtml(lyric.orderIndex)}</span>
      <span class="mobile-lyric-text">${escapeHtml(lyric.text)}</span>
      <span class="mobile-count${countClass}">${count}</span>
    </div>
  `;
}

// 渲染上传者自己的行内视频。
function renderInlineUploaderVideo(match) {
  const video = match.video;
  const status = video.transcode_status || "pending";
  const playable = isVideoPlayable(video);
  const playbackUrl = getVideoPlaybackUrl(video);
  return `
    <article class="inline-video-card">
      ${playable ? `
        <video
          controls
          playsinline
          preload="none"
          data-video-preview
          data-video-id="${escapeHtml(video.id)}"
          data-video-title="${escapeHtml(video.original_filename)}"
          data-src="${escapeHtml(playbackUrl)}"
        ></video>
      ` : renderVideoUnavailable(video)}
      <div>
        <strong>${escapeHtml(video.original_filename)}</strong>
        <span>${escapeHtml(videoStatusLabels[video.status] || video.status)} · ${escapeHtml(transcodeStatusLabels[status] || status)} · ${escapeHtml(linkStatusLabels[match.link.status] || match.link.status)}</span>
      </div>
    </article>
  `;
}

// 渲染上传者移动端歌词行，标注自己已上传的歌词。
function renderUploaderLyricRow(lyric) {
  const publicCount = countVideosForLyric(lyric);
  const ownMatches = getUploaderVideosForLyric(lyric.id);
  const expanded = lyric.id === state.expandedUploaderLyricId;
  const selecting = state.uploadSelectionMode;
  const selected = isUploadLyricSelected(lyric.id);
  const countClass = publicCount === 0 ? " zero" : "";
  const marker = ownMatches.length > 0 && !selecting
    ? `<span class="my-marker">我的 ${ownMatches.length}</span>`
    : "";
  let videosHtml = "";
  if (expanded && !selecting) {
    for (let i = 0; i < ownMatches.length; i += 1) {
      videosHtml += renderInlineUploaderVideo(ownMatches[i]);
    }
    if (!videosHtml) {
      videosHtml = '<div class="inline-empty">还没有上传这一句。</div>';
    }
  }
  return `
    <div class="mobile-row-block${expanded && !selecting ? " expanded" : ""}${selected ? " selected" : ""}">
      <button
        type="button"
        class="mobile-lyric-row uploader-lyric-row${selecting ? " selecting" : ""}${selected ? " selected" : ""}"
        data-action="${selecting ? "toggle-upload-lyric" : "select-lyric"}"
        data-id="${escapeHtml(lyric.id)}"
        ${selecting ? `aria-pressed="${selected ? "true" : "false"}"` : ""}
      >
        ${selecting ? `<span class="mobile-select-box${selected ? " checked" : ""}" aria-hidden="true"></span>` : ""}
        <span class="mobile-index">${escapeHtml(lyric.orderIndex)}</span>
        <span class="mobile-lyric-text">${escapeHtml(lyric.text)}</span>
        ${marker}
        <span class="mobile-count${countClass}">${publicCount}</span>
      </button>
      ${expanded && !selecting ? `<div class="inline-video-list">${videosHtml}</div>` : ""}
    </div>
  `;
}

// 渲染歌词进度列表。
function renderLyricList(selector) {
  const list = find(selector);
  let html = "";
  for (let i = 0; i < state.lyrics.length; i += 1) {
    html += renderLyricRow(state.lyrics[i]);
  }
  list.innerHTML = html || '<div class="queue"><div class="queue-item"><strong>暂无歌词</strong><p>请先初始化数据库。</p></div></div>';
}

// 渲染移动端访客歌词列表。
function renderVisitorLyricList() {
  let html = "";
  for (let i = 0; i < state.lyrics.length; i += 1) {
    html += renderVisitorLyricRow(state.lyrics[i]);
  }
  find("#visitorLyricList").innerHTML = html || '<div class="inline-empty">暂无歌词。</div>';
}

// 渲染移动端上传者歌词列表。
function renderUploaderLyricList() {
  let html = "";
  for (let i = 0; i < state.lyrics.length; i += 1) {
    html += renderUploaderLyricRow(state.lyrics[i]);
  }
  find("#uploaderLyricList").innerHTML = html || '<div class="inline-empty">暂无歌词。</div>';
}

// 渲染视频卡片。
function renderVideoCard(video) {
  const status = video.transcodeStatus || "pending";
  const playable = isVideoPlayable(video);
  const playbackUrl = getVideoPlaybackUrl(video);
  const deleteButton = video.videoId
    ? `
      <div class="queue-actions video-card-actions">
        <button class="danger" type="button" data-action="delete-video" data-id="${escapeHtml(video.videoId)}">删除视频</button>
      </div>
    `
    : "";
  return `
    <article class="video-card">
      ${playable ? `
        <video
          controls
          playsinline
          preload="none"
          data-video-preview
          data-video-id="${escapeHtml(video.videoId)}"
          data-video-title="${escapeHtml(video.title)}"
          data-src="${escapeHtml(playbackUrl)}"
        ></video>
      ` : renderVideoUnavailable(video)}
      <div class="video-body">
        <strong>${escapeHtml(video.title)}</strong>
        <span>${escapeHtml(video.personName)} · ${escapeHtml(videoStatusLabels[video.videoStatus] || video.videoStatus)} · ${escapeHtml(transcodeStatusLabels[status] || status)} · ${escapeHtml(linkStatusLabels[video.linkStatus] || video.linkStatus)}</span>
        ${deleteButton}
      </div>
    </article>
  `;
}

// 渲染当前歌词详情。
function renderDetail(prefix, options = {}) {
  const lyric = getLyricById(state.activeLyricId);
  const grid = find(`#${prefix}VideoGrid`);

  if (!lyric) {
    find(`#${prefix}DetailLyric`).textContent = "暂无歌词";
    find(`#${prefix}DetailCount`).textContent = "0 个视频";
    find(`#${prefix}DetailStatus`).textContent = "-";
    grid.innerHTML = "";
    if (options.editable) {
      find("#adminLyricEditor").value = "";
    }
    return;
  }

  const count = countVideosForLyric(lyric);
  find(`#${prefix}DetailLyric`).textContent = lyric.text;
  find(`#${prefix}DetailCount`).textContent = `${count} 个视频`;
  find(`#${prefix}DetailStatus`).textContent = count > 0 ? "已收集" : "缺素材";
  find(`#${prefix}DetailStatus`).className = `badge ${count > 0 ? "good" : "warn"}`;
  if (options.editable) {
    find("#adminLyricEditor").value = lyric.text;
  }

  let html = "";
  for (let i = 0; i < lyric.videos.length; i += 1) {
    html += renderVideoCard(lyric.videos[i]);
  }
  grid.innerHTML = html || '<div class="queue-item"><strong>暂无视频</strong><p>这一句会在总览里保持缺素材状态。</p></div>';
}

// 渲染访客页。
function renderVisitorPage() {
  find("#visitorSummary").textContent = `${state.stats.lyricCount} 句歌词 · ${state.stats.videoCount} 个视频 · ${countMissingLyrics()} 句待补`;
  renderVisitorLyricList();
}

// 渲染上传表单里的已选歌词摘要，歌词选择只在主页列表中完成。
function renderUploadSelectedLyrics() {
  const list = find("#uploadSelectedLyrics");
  const selectedLyrics = getSelectedUploadLyrics();
  let html = "";
  for (let i = 0; i < selectedLyrics.length; i += 1) {
    const lyric = selectedLyrics[i];
    html += `
      <span class="selected-lyric-pill">${escapeHtml(lyric.orderIndex)}. ${escapeHtml(lyric.text)}</span>
    `;
  }
  list.innerHTML = html || '<span class="hint">未绑定歌词，将作为花絮提交。</span>';
}

// 返回上传选择模式里的引导文字。
function getUploadSelectionHint() {
  const selectedCount = state.uploadLyricIds.length;
  if (selectedCount === 0) {
    return "暂未选择歌词；直接点击下一步将作为花絮提交";
  }
  return `已选 ${selectedCount} 句歌词；点击下一步继续上传`;
}

// 渲染上传者页面。
function renderUploaderPage() {
  const hasName = Boolean(state.sessionName);
  const addButton = find("#uploaderAddButton");
  const logoutButton = find("#uploaderLogoutButton");
  const cancelSelectionButton = find("#uploaderCancelSelectionButton");
  find("#uploaderLoginPanel").hidden = hasName;
  find("#uploaderDashboard").hidden = !hasName;
  addButton.hidden = !hasName;
  logoutButton.hidden = !hasName || state.uploadSelectionMode;
  cancelSelectionButton.hidden = !hasName || !state.uploadSelectionMode;
  if (!hasName) {
    return;
  }

  find("#uploaderGreeting").textContent = `你好，${state.sessionName}`;
  addButton.textContent = state.uploadSelectionMode ? "下一步" : "添加视频";
  addButton.classList.toggle("primary", state.uploadSelectionMode);
  addButton.disabled = false;
  find("#uploaderSummary").textContent = state.uploadSelectionMode
    ? getUploadSelectionHint()
    : `${countVisibleUploaderVideos()} 个我的视频`;
  renderUploaderLyricList();
}

// 渲染上传者自己的歌词摘要。
function renderUploaderLinkSummary(links) {
  if (!links || links.length === 0) {
    return "未关联歌词";
  }
  let html = "";
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    html += `
      <span class="mini-line">
        ${escapeHtml(link.orderIndex || "-")}. ${escapeHtml(link.lyricText || "歌词已停用")}
        <span class="badge ${getStatusClass(link.status)}">${escapeHtml(linkStatusLabels[link.status] || link.status)}</span>
      </span>
    `;
  }
  return html;
}

// 渲染上传者自己的视频列表。
function renderUploaderVideos() {
  const list = find("#uploaderVideoList");
  let html = "";
  for (let i = 0; i < state.uploaderVideos.length; i += 1) {
    const video = state.uploaderVideos[i];
    if (!isVisibleUploaderVideo(video)) {
      continue;
    }
    const transcodeStatus = video.transcode_status || "pending";
    const playable = isVideoPlayable(video);
    const playbackUrl = getVideoPlaybackUrl(video);
    html += `
      <div class="queue-item">
        <div class="queue-title">
          <strong>${escapeHtml(video.original_filename)}</strong>
          <span class="badge ${getStatusClass(video.status)}">${escapeHtml(videoStatusLabels[video.status] || video.status)}</span>
        </div>
        <p>${escapeHtml(formatDate(video.created_at))} 上传 · ${escapeHtml(transcodeStatusLabels[transcodeStatus] || transcodeStatus)}</p>
        <div class="mini-list">${renderUploaderLinkSummary(video.lyric_links)}</div>
        <div class="queue-actions">
          ${playable ? `<a class="button" href="${escapeHtml(playbackUrl)}" target="_blank" rel="noreferrer">查看播放副本</a>` : ""}
        </div>
      </div>
    `;
  }
  list.innerHTML = html || '<div class="queue-item"><strong>暂无视频</strong><p>提交后会出现在这里。</p></div>';
}

// 渲染管理员页面。
function renderAdminPage() {
  const allowed = isAdminSession();
  find("#adminLoginPanel").hidden = allowed;
  find("#adminDashboard").hidden = !allowed;
  find("#adminLoginStatus").textContent = state.sessionName && !allowed
    ? "当前姓名没有管理员权限。"
    : "";

  if (!allowed) {
    return;
  }

  find("#adminStatLyrics").textContent = state.stats.lyricCount;
  find("#adminStatVideos").textContent = state.stats.videoCount;
  find("#adminStatPeople").textContent = state.stats.personCount;
  renderLyricList("#adminLyricList");
  renderDetail("admin", { editable: true });
  renderRelinkQueue();
  renderStructureEditor();
  renderMetronome();
}

// 渲染待整理视频队列中的歌词摘要。
function renderLinkSummary(links) {
  if (!links || links.length === 0) {
    return "未关联歌词";
  }
  let text = "";
  for (let i = 0; i < links.length; i += 1) {
    if (i > 0) {
      text += " / ";
    }
    text += links[i].lyricText;
  }
  return text;
}

// 渲染待整理视频队列。
function renderPendingQueue() {
  const queue = find("#pendingQueue");
  let html = "";
  for (let i = 0; i < state.pendingVideos.length; i += 1) {
    const video = state.pendingVideos[i];
    const transcodeStatus = video.transcode_status || "pending";
    const playable = isVideoPlayable(video);
    const playbackUrl = getVideoPlaybackUrl(video);
    html += `
      <div class="queue-item">
        <strong>${escapeHtml(video.original_filename)}</strong>
        <p>${escapeHtml(video.person_name)} 上传 · ${escapeHtml(renderLinkSummary(video.lyric_links))}</p>
        <p>转码状态：${escapeHtml(transcodeStatusLabels[transcodeStatus] || transcodeStatus)}</p>
        <div class="queue-actions">
          ${playable ? `<a class="button" href="${escapeHtml(playbackUrl)}" target="_blank" rel="noreferrer">查看播放副本</a>` : ""}
          <button type="button" data-action="review-video" data-id="${escapeHtml(video.id)}"${playable ? "" : " disabled"}>通过</button>
          <button class="danger" type="button" data-action="reject-video" data-id="${escapeHtml(video.id)}">驳回</button>
        </div>
      </div>
    `;
  }
  queue.innerHTML = html || '<div class="queue-item"><strong>暂无待整理视频</strong><p>新上传的视频会出现在这里。</p></div>';
}

// 渲染 Relink 暂存任务队列。
function renderRelinkQueue() {
  const queue = find("#relinkQueue");
  let html = "";
  for (let i = 0; i < state.relinkTasks.length; i += 1) {
    const task = state.relinkTasks[i];
    html += `
      <div class="queue-item">
        <strong>${escapeHtml(task.original_filename)}</strong>
        <p>${escapeHtml(task.person_name)} · 原句：${escapeHtml(task.old_lyric_text)}</p>
        <p>${escapeHtml(task.reason)}</p>
        <div class="queue-actions">
          <button type="button" data-action="resolve-relink" data-id="${escapeHtml(task.id)}">重新选择歌词</button>
          <button class="danger" type="button" data-action="ignore-relink" data-id="${escapeHtml(task.id)}">忽略</button>
        </div>
      </div>
    `;
  }
  queue.innerHTML = html || '<div class="queue-item"><strong>暂无 Relink 任务</strong><p>结构性歌词修改后会在这里生成任务。</p></div>';
}

// 渲染整体歌词结构编辑器。
function renderStructureEditor() {
  let text = "";
  for (let i = 0; i < state.lyrics.length; i += 1) {
    if (i > 0) {
      text += "\n";
    }
    text += state.lyrics[i].text;
  }
  find("#structureEditor").value = text;
}

// 在当前页面展示加载失败信息。
function renderPageError(error) {
  const message = escapeHtml(error.message);
  if (state.view === "visitor") {
    find("#visitorLyricList").innerHTML = `<div class="inline-empty">无法连接后端：${message}</div>`;
  } else if (state.view === "uploader") {
    find("#uploaderLyricList").innerHTML = `<div class="inline-empty">加载失败：${message}</div>`;
  } else if (state.view === "admin" && isAdminSession()) {
    find("#relinkQueue").innerHTML = `<div class="queue-item"><strong>加载失败</strong><p>${message}</p></div>`;
  } else {
    find("#adminLoginStatus").textContent = error.message;
  }
}

// 保存当前选中歌词的普通文字修改。
async function saveCurrentLyric() {
  const lyric = getLyricById(state.activeLyricId);
  if (!lyric) {
    return;
  }
  find("#editStatus").textContent = "保存中...";
  await requestJson(`/api/admin/lyrics/${encodeURIComponent(lyric.id)}`, withUserHeaders({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: find("#adminLyricEditor").value
    })
  }));
  find("#editStatus").textContent = "已保存文字修改，原有关联保持不变。";
  await loadAdminOverview();
  renderAll();
}

// 保存整体歌词结构修改。
async function saveStructure() {
  const confirmed = window.confirm("结构保存会替换当前歌词，并把已有视频关联放入 Relink 暂存区。确定继续？");
  if (!confirmed) {
    return;
  }
  find("#structureStatus").textContent = "保存中...";
  const result = await requestJson("/api/admin/lyrics/structure", withUserHeaders({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ structureText: find("#structureEditor").value })
  }));
  find("#structureStatus").textContent = `已保存 ${result.lyricCount} 句歌词，影响 ${result.impactedCount} 条关联。`;
  state.activeLyricId = null;
  await loadAdminOverview();
  renderAll();
}

// 审核通过指定视频。
async function reviewVideo(videoId) {
  await requestJson(`/api/admin/videos/${encodeURIComponent(videoId)}/review`, withUserHeaders({ method: "POST" }));
  await loadAdminOverview();
  renderAll();
}

// 驳回指定视频。
async function rejectVideo(videoId) {
  const confirmed = window.confirm("确定驳回这个视频？");
  if (!confirmed) {
    return;
  }
  await requestJson(`/api/admin/videos/${encodeURIComponent(videoId)}/reject`, withUserHeaders({ method: "POST" }));
  await loadAdminOverview();
  renderAll();
}

// 管理员删除视频时采用归档，保留文件记录以便后续人工恢复。
async function deleteVideo(videoId) {
  const confirmed = window.confirm("确定删除这个视频？删除后页面不再展示。");
  if (!confirmed) {
    return;
  }
  try {
    await requestJson(`/api/admin/videos/${encodeURIComponent(videoId)}`, withUserHeaders({ method: "DELETE" }));
  } catch (error) {
    if (error.message !== "接口不存在") {
      throw error;
    }
    // 兼容未重启的旧服务：旧后端没有 DELETE 路由，但驳回接口同样会让视频退出展示。
    await requestJson(`/api/admin/videos/${encodeURIComponent(videoId)}/reject`, withUserHeaders({ method: "POST" }));
  }
  await loadAdminOverview();
  renderAll();
}

// 让管理员用歌词序号处理 Relink 任务。
async function resolveRelink(taskId) {
  const raw = window.prompt("输入新的歌词序号，例如 1");
  const orderIndex = Number(raw);
  const lyric = getLyricByOrder(orderIndex);
  if (!lyric) {
    window.alert("没有找到这个歌词序号");
    return;
  }
  await requestJson(`/api/admin/relink-tasks/${encodeURIComponent(taskId)}/resolve`, withUserHeaders({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lyricId: lyric.id })
  }));
  await loadAdminOverview();
  renderAll();
}

// 忽略指定 Relink 任务。
async function ignoreRelink(taskId) {
  const confirmed = window.confirm("确定忽略这个 Relink 任务？");
  if (!confirmed) {
    return;
  }
  await requestJson(`/api/admin/relink-tasks/${encodeURIComponent(taskId)}/ignore`, withUserHeaders({ method: "POST" }));
  await loadAdminOverview();
  renderAll();
}

// 从上传表单中收集被选中的歌词标识。
function collectSelectedLyricIds() {
  return state.uploadLyricIds.slice();
}

// 进入上传前的歌词选择模式。
function startUploadSelection() {
  state.uploadSelectionMode = true;
  state.uploadLyricIds = [];
  state.expandedUploaderLyricId = null;
  renderAll();
}

// 在主页歌词列表中切换本次上传要关联的歌词。
function toggleUploadLyric(lyricId) {
  if (isUploadLyricSelected(lyricId)) {
    state.uploadLyricIds = state.uploadLyricIds.filter(function keepDifferentId(id) {
      return id !== lyricId;
    });
  } else {
    state.uploadLyricIds.push(lyricId);
  }
  renderAll();
}

// 取消当前上传前的歌词选择状态。
function cancelUploadSelection() {
  resetUploadSelection();
  renderAll();
}

// 顶栏添加按钮：第一次进入选择，选择完成后进入上传表单。
function handleUploaderAddAction() {
  if (!state.sessionName) {
    openLoginSheet();
    return;
  }
  if (!state.uploadSelectionMode) {
    startUploadSelection();
    return;
  }
  openUploadSheet();
}

// 把选择的视频文件加入上传表单数据。
function appendSelectedFiles(formData) {
  const files = find("#videoFiles").files;
  for (let i = 0; i < files.length; i += 1) {
    formData.append("videos", files[i]);
  }
}

// 上传和转码期间锁住表单，避免用户重复提交。
function setUploadBusy(isBusy, message) {
  const form = find("#uploadForm");
  const controls = form.querySelectorAll("input, textarea, button");
  for (let i = 0; i < controls.length; i += 1) {
    controls[i].disabled = isBusy;
  }
  find("#uploadStatus").textContent = message || "";
}

// 处理上传表单提交。
async function handleUploadSubmit(event) {
  event.preventDefault();
  if (!state.sessionName) {
    openLoginSheet();
    return;
  }

  const lyricIds = collectSelectedLyricIds();
  const isOuttakeUpload = lyricIds.length === 0;

  const formData = new FormData();
  formData.append("name", state.sessionName);
  formData.append("contact", find("#contact").value);
  formData.append("note", find("#uploadNote").value);
  formData.append("lyricIds", JSON.stringify(lyricIds));
  appendSelectedFiles(formData);

  setUploadBusy(true, "上传中，上传完成后服务器会继续转码，请不要关闭页面...");
  try {
    await requestJson("/api/uploads", withUserHeaders({
      method: "POST",
      body: formData
    }));
    setUploadBusy(false, isOuttakeUpload
      ? "已作为花絮上传并完成低码率转码。"
      : "已上传并完成低码率转码。");
    find("#uploadForm").reset();
    await loadPublicOverview();
    await loadUploaderData();
    closeUploadSheet();
    renderAll();
  } catch (error) {
    setUploadBusy(false, `上传或转码失败：${error.message}`);
  }
}

// 打开姓名输入抽屉。
function openLoginSheet() {
  find("#loginSheet").hidden = false;
  find("#quickLoginName").value = state.sessionName;
  find("#quickLoginName").focus();
}

// 关闭姓名输入抽屉。
function closeLoginSheet() {
  find("#loginSheet").hidden = true;
}

// 打开上传抽屉；没有选择歌词时按花絮提交。
function openUploadSheet() {
  if (!state.sessionName) {
    openLoginSheet();
    return;
  }
  state.uploadSelectionMode = false;
  renderAll();
  renderUploadSelectedLyrics();
  find("#uploadStatus").textContent = "";
  find("#uploadSheet").hidden = false;
}

// 关闭上传抽屉。
function closeUploadSheet() {
  find("#uploadSheet").hidden = true;
  resetUploadSelection();
  renderAll();
}

// 保存姓名并刷新当前页面。
async function loginWithName(name) {
  const normalized = normalizeText(name);
  if (!normalized) {
    window.alert("请填写姓名");
    return;
  }
  state.sessionName = normalized;
  window.localStorage.setItem(SESSION_KEY, normalized);
  closeLoginSheet();
  if (normalized.toLowerCase() === ADMIN_NAME && state.view !== "admin") {
    window.location.assign("/admin");
    return;
  }
  if (state.view === "visitor") {
    window.location.assign("/uploader");
    return;
  }
  await refreshCurrentView();
}

// 清除当前姓名，并统一回到访客总览。
async function logout() {
  state.sessionName = "";
  state.uploaderVideos = [];
  state.uploaderStats = {
    totalCount: 0,
    pendingCount: 0,
    reviewedCount: 0,
    rejectedCount: 0
  };
  state.expandedUploaderLyricId = null;
  resetUploadSelection();
  stopMetronome();
  window.localStorage.removeItem(SESSION_KEY);
  closeLoginSheet();
  find("#uploadSheet").hidden = true;
  if (state.view !== "visitor") {
    window.location.assign("/");
    return;
  }
  await refreshCurrentView();
}

// 处理页面上的按钮点击。
async function handleDocumentClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;
  if (action === "select-lyric") {
    if (state.view === "uploader") {
      state.activeLyricId = target.dataset.id;
      state.expandedUploaderLyricId = state.expandedUploaderLyricId === target.dataset.id
        ? null
        : target.dataset.id;
      renderAll();
      return;
    }
    state.activeLyricId = target.dataset.id;
    renderAll();
    return;
  }

  if (action === "toggle-upload-lyric") {
    toggleUploadLyric(target.dataset.id);
    return;
  }

  try {
    if (action === "reload") {
      await refreshCurrentView();
    } else if (action === "logout") {
      await logout();
    } else if (action === "open-login") {
      openLoginSheet();
    } else if (action === "close-login") {
      closeLoginSheet();
    } else if (action === "open-upload") {
      handleUploaderAddAction();
    } else if (action === "cancel-upload-selection") {
      cancelUploadSelection();
    } else if (action === "close-upload") {
      closeUploadSheet();
    } else if (action === "save-lyric") {
      await saveCurrentLyric();
    } else if (action === "save-structure") {
      await saveStructure();
    } else if (action === "toggle-metronome") {
      await toggleMetronome();
    } else if (action === "tap-metronome") {
      tapMetronomeTempo();
    } else if (action === "review-video") {
      await reviewVideo(target.dataset.id);
    } else if (action === "reject-video") {
      await rejectVideo(target.dataset.id);
    } else if (action === "delete-video") {
      await deleteVideo(target.dataset.id);
    } else if (action === "resolve-relink") {
      await resolveRelink(target.dataset.id);
    } else if (action === "ignore-relink") {
      await ignoreRelink(target.dataset.id);
    }
  } catch (error) {
    window.alert(error.message);
  }
}

// 处理上传者登录表单。
async function handleUploaderLogin(event) {
  event.preventDefault();
  await loginWithName(find("#uploaderNameInput").value);
}

// 处理管理员登录表单。
async function handleAdminLogin(event) {
  event.preventDefault();
  await loginWithName(find("#adminNameInput").value);
}

// 处理访客浮动按钮打开的姓名输入。
async function handleQuickLogin(event) {
  event.preventDefault();
  await loginWithName(find("#quickLoginName").value);
}

// 处理节拍器滑杆的即时速度调整。
function handleDocumentInput(event) {
  if (event.target.id === "metronomeBpmRange") {
    setMetronomeBpm(event.target.value);
  }
}

// 处理节拍器数字输入和拍号选择。
function handleDocumentChange(event) {
  if (event.target.id === "metronomeBpmInput") {
    setMetronomeBpm(event.target.value);
  } else if (event.target.id === "metronomeBeatsInput") {
    setMetronomeBeats(event.target.value);
  }
}

// 绑定页面事件。
function bindEvents() {
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("input", handleDocumentInput);
  document.addEventListener("change", handleDocumentChange);
  find("#uploaderLoginForm").addEventListener("submit", handleUploaderLogin);
  find("#adminLoginForm").addEventListener("submit", handleAdminLogin);
  find("#quickLoginForm").addEventListener("submit", handleQuickLogin);
  find("#uploadForm").addEventListener("submit", handleUploadSubmit);
}

// 初始化前端应用。
async function initApp() {
  bindEvents();
  await refreshCurrentView();
}

document.addEventListener("DOMContentLoaded", initApp);
