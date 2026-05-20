const state = {
  lyrics: [],
  stats: {
    lyricCount: 0,
    videoCount: 0,
    personCount: 0,
    pendingCount: 0
  },
  pendingVideos: [],
  relinkTasks: [],
  activeLyricId: null
};

// 根据选择器获取单个页面元素。
function find(selector) {
  return document.querySelector(selector);
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

// 加载总览数据并刷新页面。
async function loadOverview() {
  const data = await requestJson("/api/overview");
  state.lyrics = data.lyrics || [];
  state.stats = data.stats || state.stats;
  state.pendingVideos = data.pendingVideos || [];
  state.relinkTasks = data.relinkTasks || [];

  if (!state.activeLyricId && state.lyrics.length > 0) {
    state.activeLyricId = state.lyrics[0].id;
  }

  if (state.activeLyricId && !getLyricById(state.activeLyricId) && state.lyrics.length > 0) {
    state.activeLyricId = state.lyrics[0].id;
  }

  renderAll();
}

// 渲染所有页面区域。
function renderAll() {
  renderStats();
  renderLyricList();
  renderDetail();
  renderUploadChoices();
  renderPendingQueue();
  renderRelinkQueue();
  renderStructureEditor();
}

// 渲染顶部和侧边栏统计。
function renderStats() {
  find("#statLyrics").textContent = state.stats.lyricCount;
  find("#statVideos").textContent = state.stats.videoCount;
  find("#statPeople").textContent = state.stats.personCount;
  find("#statPending").textContent = state.stats.pendingCount;
  find("#navLyricCount").textContent = state.stats.lyricCount;
  find("#navPendingCount").textContent = state.stats.pendingCount;
}

// 统计某句歌词的可展示视频数量。
function countVideosForLyric(lyric) {
  return lyric.videos ? lyric.videos.length : 0;
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

// 渲染歌词进度列表。
function renderLyricList() {
  const list = find("#lyricList");
  let html = "";
  for (let i = 0; i < state.lyrics.length; i += 1) {
    html += renderLyricRow(state.lyrics[i]);
  }
  list.innerHTML = html || '<div class="queue"><div class="queue-item"><strong>暂无歌词</strong><p>请先初始化数据库。</p></div></div>';
}

// 渲染视频卡片。
function renderVideoCard(video) {
  return `
    <article class="video-card">
      <video
        controls
        playsinline
        preload="none"
        data-video-preview
        data-video-id="${escapeHtml(video.videoId)}"
        data-video-title="${escapeHtml(video.title)}"
        data-src="${escapeHtml(video.fileUrl)}"
      ></video>
      <div class="video-body">
        <strong>${escapeHtml(video.title)}</strong>
        <span>${escapeHtml(video.personName)} · ${escapeHtml(video.videoStatus)} · ${escapeHtml(video.linkStatus)}</span>
      </div>
    </article>
  `;
}

// 渲染当前歌词详情。
function renderDetail() {
  const lyric = getLyricById(state.activeLyricId);
  const grid = find("#videoGrid");

  if (!lyric) {
    find("#detailLyric").textContent = "暂无歌词";
    find("#detailCount").textContent = "0 个视频";
    find("#detailStatus").textContent = "-";
    find("#lyricEditor").value = "";
    grid.innerHTML = "";
    return;
  }

  const count = countVideosForLyric(lyric);
  find("#detailLyric").textContent = lyric.text;
  find("#detailCount").textContent = `${count} 个视频`;
  find("#detailStatus").textContent = count > 0 ? "已收集" : "缺素材";
  find("#detailStatus").className = `badge ${count > 0 ? "good" : "warn"}`;
  find("#lyricEditor").value = lyric.text;

  let html = "";
  for (let i = 0; i < lyric.videos.length; i += 1) {
    html += renderVideoCard(lyric.videos[i]);
  }
  grid.innerHTML = html || '<div class="queue-item"><strong>暂无视频</strong><p>这一句会在总览里保持缺素材状态。</p></div>';
  prepareVideoPreviews();
}

// 渲染上传表单里的歌词多选项。
function renderUploadChoices() {
  const list = find("#uploadChoices");
  let html = "";
  for (let i = 0; i < state.lyrics.length; i += 1) {
    const lyric = state.lyrics[i];
    const checked = lyric.id === state.activeLyricId ? " checked" : "";
    html += `
      <label class="choice">
        <input type="checkbox" name="lyricIds" value="${escapeHtml(lyric.id)}"${checked}>
        <span>${escapeHtml(lyric.orderIndex)}. ${escapeHtml(lyric.text)}</span>
      </label>
    `;
  }
  list.innerHTML = html;
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
    html += `
      <div class="queue-item">
        <strong>${escapeHtml(video.original_filename)}</strong>
        <p>${escapeHtml(video.person_name)} 上传 · ${escapeHtml(renderLinkSummary(video.lyric_links))}</p>
        <div class="queue-actions">
          <a class="button" href="${escapeHtml(video.file_url)}" target="_blank" rel="noreferrer">查看视频</a>
          <button type="button" data-action="review-video" data-id="${escapeHtml(video.id)}">通过</button>
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

// 保存当前选中歌词的普通文字修改。
async function saveCurrentLyric() {
  const lyric = getLyricById(state.activeLyricId);
  if (!lyric) {
    return;
  }
  find("#editStatus").textContent = "保存中...";
  await requestJson(`/api/lyrics/${encodeURIComponent(lyric.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: find("#lyricEditor").value
    })
  });
  find("#editStatus").textContent = "已保存文字修改，原有关联保持不变。";
  await loadOverview();
}

// 保存整体歌词结构修改。
async function saveStructure() {
  const confirmed = window.confirm("结构保存会替换当前歌词，并把已有视频关联放入 Relink 暂存区。确定继续？");
  if (!confirmed) {
    return;
  }
  find("#structureStatus").textContent = "保存中...";
  const result = await requestJson("/api/lyrics/structure", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ structureText: find("#structureEditor").value })
  });
  find("#structureStatus").textContent = `已保存 ${result.lyricCount} 句歌词，影响 ${result.impactedCount} 条关联。`;
  state.activeLyricId = null;
  await loadOverview();
}

// 审核通过指定视频。
async function reviewVideo(videoId) {
  await requestJson(`/api/videos/${encodeURIComponent(videoId)}/review`, { method: "POST" });
  await loadOverview();
}

// 驳回指定视频。
async function rejectVideo(videoId) {
  const confirmed = window.confirm("确定驳回这个视频？");
  if (!confirmed) {
    return;
  }
  await requestJson(`/api/videos/${encodeURIComponent(videoId)}/reject`, { method: "POST" });
  await loadOverview();
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
  await requestJson(`/api/relink-tasks/${encodeURIComponent(taskId)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lyricId: lyric.id })
  });
  await loadOverview();
}

// 忽略指定 Relink 任务。
async function ignoreRelink(taskId) {
  const confirmed = window.confirm("确定忽略这个 Relink 任务？");
  if (!confirmed) {
    return;
  }
  await requestJson(`/api/relink-tasks/${encodeURIComponent(taskId)}/ignore`, { method: "POST" });
  await loadOverview();
}

// 处理页面上的按钮点击。
async function handleDocumentClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;
  if (action === "select-lyric") {
    state.activeLyricId = target.dataset.id;
    renderAll();
    return;
  }

  try {
    if (action === "reload") {
      await loadOverview();
    } else if (action === "save-lyric") {
      await saveCurrentLyric();
    } else if (action === "save-structure") {
      await saveStructure();
    } else if (action === "review-video") {
      await reviewVideo(target.dataset.id);
    } else if (action === "reject-video") {
      await rejectVideo(target.dataset.id);
    } else if (action === "resolve-relink") {
      await resolveRelink(target.dataset.id);
    } else if (action === "ignore-relink") {
      await ignoreRelink(target.dataset.id);
    }
  } catch (error) {
    window.alert(error.message);
  }
}

// 从上传表单中收集被选中的歌词标识。
function collectSelectedLyricIds() {
  const boxes = document.querySelectorAll('input[name="lyricIds"]:checked');
  const ids = [];
  for (let i = 0; i < boxes.length; i += 1) {
    ids.push(boxes[i].value);
  }
  return ids;
}

// 把选择的视频文件加入上传表单数据。
function appendSelectedFiles(formData) {
  const files = find("#videoFiles").files;
  for (let i = 0; i < files.length; i += 1) {
    formData.append("videos", files[i]);
  }
}

// 处理上传表单提交。
async function handleUploadSubmit(event) {
  event.preventDefault();
  const lyricIds = collectSelectedLyricIds();
  if (lyricIds.length === 0) {
    window.alert("请至少选择一句歌词");
    return;
  }

  const formData = new FormData();
  formData.append("name", find("#personName").value);
  formData.append("contact", find("#contact").value);
  formData.append("note", find("#uploadNote").value);
  formData.append("lyricIds", JSON.stringify(lyricIds));
  appendSelectedFiles(formData);

  find("#uploadStatus").textContent = "上传中...";
  await requestJson("/api/uploads", {
    method: "POST",
    body: formData
  });
  find("#uploadStatus").textContent = "已上传，等待管理员整理。";
  find("#uploadForm").reset();
  await loadOverview();
}

// 绑定页面事件。
function bindEvents() {
  document.addEventListener("click", handleDocumentClick);
  find("#uploadForm").addEventListener("submit", handleUploadSubmit);
}

// 初始化前端应用。
async function initApp() {
  bindEvents();
  try {
    await loadOverview();
  } catch (error) {
    find("#detailLyric").textContent = "加载失败";
    find("#videoGrid").innerHTML = `<div class="queue-item"><strong>无法连接后端</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

document.addEventListener("DOMContentLoaded", initApp);
