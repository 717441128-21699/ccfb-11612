/**
 * 主程序：摄像头采集、洋葱皮联动、拍摄/重拍/插帧、回放、导出。
 */

import { Compositor } from './compositor';
import { FrameStore } from './store';
import { compareFrames } from './compare';
import { exportMp4 } from './exporter';

type Mode = 'append' | 'replace' | 'insert';

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const canvas = $<HTMLCanvasElement>('view');
const camStatus = $('camStatus');
const modeBadge = $('modeBadge');
const warningBox = $('warning');
const onionOpacity = $<HTMLInputElement>('onionOpacity');
const onionPrev = $<HTMLInputElement>('onionPrev');
const onionPrev2 = $<HTMLInputElement>('onionPrev2');
const onionNext = $<HTMLInputElement>('onionNext');
const btnCapture = $<HTMLButtonElement>('btnCapture');
const btnReplace = $<HTMLButtonElement>('btnReplace');
const btnInsert = $<HTMLButtonElement>('btnInsert');
const btnDelete = $<HTMLButtonElement>('btnDelete');
const frameInfo = $('frameInfo');
const btnPlay = $<HTMLButtonElement>('btnPlay');
const loopEl = $<HTMLInputElement>('loop');
const btnExport = $<HTMLButtonElement>('btnExport');
const exportProgress = $<HTMLProgressElement>('exportProgress');
const exportStatus = $('exportStatus');
const timeline = $('timeline');

const store = new FrameStore();
const compositor = new Compositor(canvas);
const video = document.createElement('video');
video.muted = true;
video.playsInline = true;

let cameraReady = false;
let mode: Mode = 'append';
let selected = -1;
let fps = 24;
let playing = false;
let playIdx = 0;
let playToken = 0;
let onionToken = 0;
let warningTimer = 0;

// ---------- 拍摄位置 ----------

/** 下一帧将被放到的索引 */
function targetPos(): number {
  if (mode === 'replace') return selected;
  if (mode === 'insert') return selected + 1;
  return store.length;
}

// ---------- 洋葱皮 ----------

async function refreshOnion(): Promise<void> {
  if (playing) return;
  const token = ++onionToken;
  const pos = targetPos();
  const frames = store.frames;

  const prev1 = pos - 1 >= 0 ? frames[pos - 1] : undefined;
  const prev2 = pos - 2 >= 0 ? frames[pos - 2] : undefined;
  let next: (typeof frames)[number] | undefined;
  if (mode === 'insert' && pos < frames.length) next = frames[pos];
  if (mode === 'replace' && pos + 1 < frames.length) next = frames[pos + 1];

  const want1 = onionPrev.checked && prev1 ? prev1 : null;
  const want2 = onionPrev2.checked && prev2 ? prev2 : null;
  const want3 = onionNext.checked && next ? next : null;

  const [b1, b2, b3] = await Promise.all([
    want1 ? store.bitmap(want1) : null,
    want2 ? store.bitmap(want2) : null,
    want3 ? store.bitmap(want3) : null,
  ]);
  if (token !== onionToken) return; // 期间状态又变了，丢弃本次结果

  compositor.setOnion(0, b1);
  compositor.setOnion(1, b2);
  compositor.setOnion(2, b3);
}

function refreshOnionParams(): void {
  const master = Number(onionOpacity.value) / 100;
  compositor.setLayer(0, { tint: [1, 0.25, 0.25], opacity: onionPrev.checked ? master : 0 });
  compositor.setLayer(1, { tint: [1, 0.6, 0.2], opacity: onionPrev2.checked ? master * 0.7 : 0 });
  compositor.setLayer(2, { tint: [0.3, 1, 0.4], opacity: onionNext.checked ? master : 0 });
}

// ---------- 拍摄 ----------

async function capture(): Promise<void> {
  if (!cameraReady || playing) return;
  if (mode !== 'append' && (selected < 0 || selected >= store.length)) return;

  btnCapture.disabled = true;
  try {
    const bmp = await createImageBitmap(video);
    const frame = await store.createFrame(bmp);
    bmp.close();

    const pos = targetPos();
    const prev = store.at(pos - 1);
    if (mode === 'replace') store.replaceAt(pos, frame);
    else store.insertAt(pos, frame);
    selected = pos;

    // 自动与前一帧比对，有问题马上提醒
    if (prev) {
      const res = compareFrames(prev.gray, frame.gray);
      if (res.warnings.length > 0) showWarning(res.warnings);
    }
  } finally {
    btnCapture.disabled = false;
    refreshAll();
  }
}

// ---------- 回放 ----------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function playLoop(token: number): Promise<void> {
  while (playing && token === playToken) {
    const total = store.length;
    if (total === 0) break;
    if (playIdx >= total) {
      if (loopEl.checked) playIdx = 0;
      else {
        stopPlayback();
        return;
      }
    }
    const t0 = performance.now();
    const frame = store.at(playIdx)!;
    const bmp = await store.bitmap(frame);
    if (!playing || token !== playToken) return;
    compositor.showStill(bmp);
    selected = playIdx;
    playIdx++;
    updateFrameInfo();
    renderTimeline();
    // 预取下一帧，避免解码卡顿
    const ahead = store.at(playIdx) ?? (loopEl.checked ? store.at(0) : undefined);
    if (ahead) store.bitmap(ahead).catch(() => {});
    await delay(Math.max(0, 1000 / fps - (performance.now() - t0)));
  }
}

function startPlayback(): void {
  if (store.length === 0) return;
  playing = true;
  playToken++;
  playIdx = selected >= 0 && selected < store.length ? selected : 0;
  btnPlay.textContent = '停止';
  btnCapture.disabled = true;
  playLoop(playToken);
}

function stopPlayback(): void {
  playing = false;
  playToken++;
  compositor.showStill(null);
  btnPlay.textContent = '播放';
  btnCapture.disabled = !cameraReady;
  refreshAll();
}

// ---------- 导出 ----------

async function doExport(): Promise<void> {
  if (playing) stopPlayback();
  btnExport.disabled = true;
  exportProgress.hidden = false;
  exportProgress.value = 0;
  exportStatus.textContent = '正在导出…';
  const t0 = performance.now();
  try {
    const blob = await exportMp4(store, fps, (done, total) => {
      exportProgress.value = (done / total) * 100;
    });
    const secs = (performance.now() - t0) / 1000;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stopmotion_1080p_${fps}fps_${store.length}帧.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    exportStatus.textContent =
      `导出完成：${store.length} 帧 @ ${fps}fps，用时 ${secs.toFixed(1)} 秒` +
      (secs > 20 ? '（超过 20 秒，可检查是否启用了硬件编码）' : '');
  } catch (e) {
    exportStatus.textContent = '导出失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    btnExport.disabled = false;
    exportProgress.hidden = true;
  }
}

// ---------- UI ----------

function showWarning(warnings: string[]): void {
  warningBox.textContent = warnings.join('\n');
  warningBox.hidden = false;
  clearTimeout(warningTimer);
  warningTimer = window.setTimeout(() => {
    warningBox.hidden = true;
  }, 8000);
}

function updateFrameInfo(): void {
  const total = store.length;
  const dur = (total / fps).toFixed(1);
  const cur = selected >= 0 && selected < total ? selected + 1 : '-';
  frameInfo.textContent = `第 ${cur} / ${total} 帧 · 时长 ${dur} 秒 @ ${fps}fps`;
}

function updateModeBadge(): void {
  modeBadge.className = 'mode-badge ' + mode;
  if (mode === 'replace') {
    modeBadge.textContent = `重拍模式：下一拍替换第 ${selected + 1} 帧（再点按钮取消）`;
  } else if (mode === 'insert') {
    modeBadge.textContent = `插帧模式：下一拍插入到第 ${selected + 1} 帧之后（再点按钮取消）`;
  } else {
    modeBadge.textContent = '追加模式：下一拍添加到末尾';
  }
  btnReplace.classList.toggle('active', mode === 'replace');
  btnInsert.classList.toggle('active', mode === 'insert');
}

function renderTimeline(): void {
  timeline.innerHTML = '';
  if (store.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有帧，点击「拍摄」开始';
    timeline.appendChild(empty);
    return;
  }
  const target = mode === 'append' ? -1 : targetPos();
  store.frames.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'thumb';
    if (i === selected) item.classList.add('selected');
    if (i === target) item.classList.add('target');
    const img = document.createElement('img');
    img.src = f.thumb;
    img.alt = `第 ${i + 1} 帧`;
    const label = document.createElement('span');
    label.textContent = String(i + 1);
    item.append(img, label);
    item.onclick = () => {
      selected = i;
      refreshAll();
    };
    timeline.appendChild(item);
  });
  // 让选中帧滚动到可见区域
  const sel = timeline.children[selected] as HTMLElement | undefined;
  sel?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function refreshAll(): void {
  if (selected >= store.length) selected = store.length - 1;
  if (mode !== 'append' && selected < 0) mode = 'append';
  updateFrameInfo();
  updateModeBadge();
  renderTimeline();
  refreshOnionParams();
  refreshOnion();
  const hasSelection = selected >= 0 && selected < store.length;
  btnReplace.disabled = !hasSelection || playing;
  btnInsert.disabled = !hasSelection || playing;
  btnDelete.disabled = !hasSelection || playing;
  btnPlay.disabled = store.length === 0;
  btnExport.disabled = store.length === 0;
}

// ---------- 事件 ----------

btnCapture.onclick = capture;

btnReplace.onclick = () => {
  mode = mode === 'replace' ? 'append' : 'replace';
  refreshAll();
};

btnInsert.onclick = () => {
  mode = mode === 'insert' ? 'append' : 'insert';
  refreshAll();
};

btnDelete.onclick = () => {
  if (selected < 0 || selected >= store.length) return;
  store.removeAt(selected);
  if (selected >= store.length) selected = store.length - 1;
  refreshAll();
};

btnPlay.onclick = () => {
  if (playing) stopPlayback();
  else startPlayback();
};

btnExport.onclick = doExport;

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="fps"]')) {
  radio.onchange = () => {
    fps = Number(radio.value);
    updateFrameInfo();
  };
}

onionOpacity.oninput = refreshOnionParams;
onionPrev.onchange = refreshAll;
onionPrev2.onchange = refreshAll;
onionNext.onchange = refreshAll;

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    capture();
  }
  if (e.code === 'Escape' && mode !== 'append') {
    mode = 'append';
    refreshAll();
  }
});

store.onChange(() => {
  // 帧数据变化（拍/删/替换）后洋葱皮与时间线需要刷新
  if (!playing) refreshAll();
});

// ---------- 启动 ----------

async function init(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    const s = stream.getVideoTracks()[0].getSettings();
    camStatus.textContent = `摄像头已连接：${s.width}×${s.height} @ ${Math.round(s.frameRate ?? 0)}fps`;
    cameraReady = true;
    btnCapture.disabled = false;
    compositor.setVideo(video);
  } catch (e) {
    camStatus.textContent = '摄像头不可用：' + (e instanceof Error ? e.message : String(e));
  }

  function loop(): void {
    compositor.render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  refreshAll();
}

init();
