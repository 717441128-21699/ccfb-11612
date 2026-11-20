/**
 * 主程序:UI  wiring、渲染循环、拍摄 / 回放 / 导出调度。
 */

import { Camera } from './camera';
import { Compositor, OnionLayer } from './compositor';
import { FrameStore, createFrame, StoredFrame } from './frameStore';
import { compareFrames } from './analysis';
import { exportMp4, downloadBlob } from './exporter';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const viewport = $<HTMLCanvasElement>('viewport');
const btnCamera = $<HTMLButtonElement>('btn-camera');
const selResolution = $<HTMLSelectElement>('sel-resolution');
const cameraStatus = $('camera-status');
const btnCapture = $<HTMLButtonElement>('btn-capture');
const btnReplace = $<HTMLButtonElement>('btn-replace');
const btnInsert = $<HTMLButtonElement>('btn-insert');
const btnDelete = $<HTMLButtonElement>('btn-delete');
const btnPlay = $<HTMLButtonElement>('btn-play');
const btnExport = $<HTMLButtonElement>('btn-export');
const exportStatus = $('export-status');
const chkOnion = $<HTMLInputElement>('chk-onion');
const rngDepth = $<HTMLInputElement>('rng-onion-depth');
const rngAlpha = $<HTMLInputElement>('rng-onion-alpha');
const colPrev = $<HTMLInputElement>('col-prev');
const colNext = $<HTMLInputElement>('col-next');
const alertBanner = $('alert-banner');
const playbackBadge = $('playback-badge');
const timeline = $('timeline');
const frameInfo = $('frame-info');

const camera = new Camera();
const store = new FrameStore();
const compositor = new Compositor(viewport);

// ---------- 状态 ----------

let playing = false;
let playIndex = 0;
let lastPlayTime = 0;
let alertTimer = 0;

function currentFps(): number {
  const checked = document.querySelector<HTMLInputElement>('input[name="fps"]:checked');
  return checked ? Number(checked.value) : 12;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---------- 告警 ----------

function showAlert(messages: string[], danger: boolean): void {
  if (messages.length === 0) {
    alertBanner.hidden = true;
    return;
  }
  alertBanner.textContent = '⚠ ' + messages.join(';');
  alertBanner.classList.toggle('danger', danger);
  alertBanner.hidden = false;
  clearTimeout(alertTimer);
  alertTimer = window.setTimeout(() => { alertBanner.hidden = true; }, 6000);
}

// ---------- 摄像头 ----------

async function connectCamera(): Promise<void> {
  const [w, h] = selResolution.value.split('x').map(Number);
  cameraStatus.textContent = '连接中…';
  btnCamera.disabled = true;
  try {
    await camera.open(w, h);
    cameraStatus.textContent = `${camera.width}×${camera.height}`;
    btnCamera.textContent = '重新连接';
    btnCapture.disabled = false;
    compositor.resize(camera.width, camera.height);
  } catch (e) {
    cameraStatus.textContent = '连接失败: ' + (e as Error).message;
  } finally {
    btnCamera.disabled = false;
  }
}

// ---------- 拍摄 ----------

async function grabFrame(): Promise<StoredFrame> {
  const bitmap = await camera.captureFrame();
  return createFrame(bitmap);
}

async function doCapture(): Promise<void> {
  if (!camera.isOpen || playing) return;
  btnCapture.disabled = true;
  try {
    const frame = await grabFrame();
    const prev = store.at(store.length - 1);
    if (prev) frame.warnings = compareFrames(prev, frame);
    store.append(frame);
    afterStoreChanged();
    showAlert(frame.warnings.map((w) => w.message), frame.warnings.some((w) => w.kind === 'shift'));
  } finally {
    btnCapture.disabled = false;
  }
}

async function doReplace(): Promise<void> {
  if (!camera.isOpen || playing || store.length === 0) return;
  const idx = store.selectedIndex;
  btnReplace.disabled = true;
  try {
    const frame = await grabFrame();
    const prev = store.at(idx - 1);
    if (prev) frame.warnings = compareFrames(prev, frame);
    const oldId = store.at(idx)!.id;
    store.replace(idx, frame);
    compositor.invalidate(oldId);
    afterStoreChanged();
    showAlert(frame.warnings.map((w) => w.message), frame.warnings.some((w) => w.kind === 'shift'));
  } finally {
    btnReplace.disabled = false;
  }
}

async function doInsert(): Promise<void> {
  if (!camera.isOpen || playing || store.length === 0) return;
  const idx = store.selectedIndex;
  btnInsert.disabled = true;
  try {
    const frame = await grabFrame();
    const prev = store.at(idx);
    if (prev) frame.warnings = compareFrames(prev, frame);
    store.insertAfter(idx, frame);
    afterStoreChanged();
    showAlert(frame.warnings.map((w) => w.message), frame.warnings.some((w) => w.kind === 'shift'));
  } finally {
    btnInsert.disabled = false;
  }
}

function doDelete(): void {
  if (playing || store.length === 0) return;
  const idx = store.selectedIndex;
  const id = store.at(idx)!.id;
  store.delete(idx);
  compositor.invalidate(id);
  afterStoreChanged();
}

// ---------- 回放 ----------

function togglePlay(): void {
  if (store.length === 0) return;
  playing = !playing;
  if (playing) {
    playIndex = 0;
    lastPlayTime = 0;
    playbackBadge.hidden = false;
    btnPlay.textContent = '⏸ 停止';
  } else {
    playbackBadge.hidden = true;
    btnPlay.textContent = '▶ 回放';
  }
}

// ---------- 导出 ----------

let exporting = false;

async function doExport(): Promise<void> {
  if (exporting || store.length === 0) return;
  exporting = true;
  btnExport.disabled = true;
  const t0 = performance.now();
  try {
    const blob = await exportMp4(store.frames, currentFps(), (p) => {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      exportStatus.textContent = `编码 ${p.encoded}/${p.total} (${elapsed}s)`;
    });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    exportStatus.textContent = `完成:${store.length} 帧用时 ${elapsed}s`;
    downloadBlob(blob, `stopmotion_${store.length}f_${currentFps()}fps.mp4`);
  } catch (e) {
    exportStatus.textContent = '导出失败: ' + (e as Error).message;
  } finally {
    exporting = false;
    btnExport.disabled = false;
  }
}

// ---------- 时间轴 / 状态刷新 ----------

function afterStoreChanged(): void {
  renderTimeline();
  updateButtons();
  updateFrameInfo();
}

function renderTimeline(): void {
  timeline.textContent = '';
  if (store.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有帧,按空格或点击"拍摄"开始';
    timeline.appendChild(empty);
    return;
  }
  store.frames.forEach((frame, i) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    if (i === store.selectedIndex) div.classList.add('selected');
    if (frame.warnings.length > 0) {
      div.classList.add('warn');
      div.title = frame.warnings.map((w) => w.message).join('\n');
    }
    const img = document.createElement('img');
    img.src = frame.thumbUrl;
    img.draggable = false;
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    div.append(img, idx);
    div.addEventListener('click', () => {
      store.select(i);
      renderTimeline();
      updateFrameInfo();
    });
    timeline.appendChild(div);
  });
  // 选中帧滚进视野
  const selected = timeline.querySelector('.thumb.selected');
  selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateButtons(): void {
  const hasFrames = store.length > 0;
  btnReplace.disabled = !camera.isOpen || !hasFrames;
  btnInsert.disabled = !camera.isOpen || !hasFrames;
  btnDelete.disabled = !hasFrames;
  btnPlay.disabled = !hasFrames;
  btnExport.disabled = !hasFrames || exporting;
}

function updateFrameInfo(): void {
  const dur = (store.length / currentFps()).toFixed(1);
  frameInfo.textContent = store.length === 0
    ? '0 帧'
    : `第 ${store.selectedIndex + 1} / ${store.length} 帧 · 时长 ${dur}s @ ${currentFps()}fps`;
}

// ---------- 渲染循环 ----------

function buildOnionLayers(): OnionLayer[] {
  if (!chkOnion.checked || store.length === 0) return [];
  const depth = Number(rngDepth.value);
  const layers: OnionLayer[] = [];
  const cur = store.selectedIndex;
  for (let d = 1; d <= depth; d++) {
    const prev = store.at(cur - d);
    if (prev) layers.push({ frame: prev, side: 'prev', depth: d });
    const next = store.at(cur + d);
    // 只有在序列中间浏览时才显示"后一帧"
    if (next && cur < store.length - 1) layers.push({ frame: next, side: 'next', depth: d });
  }
  return layers;
}

function renderLoop(now: number): void {
  if (playing) {
    const interval = 1000 / currentFps();
    if (now - lastPlayTime >= interval) {
      lastPlayTime = now;
      playIndex = (playIndex + 1) % store.length;
    }
    compositor.render({
      live: null,
      baseFrame: store.at(playIndex) ?? null,
      onion: [],
      prevColor: [1, 1, 1],
      nextColor: [1, 1, 1],
      onionAlpha: 0,
    });
  } else {
    // 拍摄模式:选中末尾时看实时画面,选中中间帧时显示该帧便于对比
    const atEnd = store.selectedIndex === store.length - 1;
    compositor.render({
      live: atEnd ? camera.video : null,
      baseFrame: atEnd ? null : store.at(store.selectedIndex) ?? null,
      onion: buildOnionLayers(),
      prevColor: hexToRgb(colPrev.value),
      nextColor: hexToRgb(colNext.value),
      onionAlpha: Number(rngAlpha.value) / 100,
    });
  }
  requestAnimationFrame(renderLoop);
}

// ---------- 事件绑定 ----------

btnCamera.addEventListener('click', connectCamera);
btnCapture.addEventListener('click', doCapture);
btnReplace.addEventListener('click', doReplace);
btnInsert.addEventListener('click', doInsert);
btnDelete.addEventListener('click', doDelete);
btnPlay.addEventListener('click', togglePlay);
btnExport.addEventListener('click', doExport);

document.querySelectorAll('input[name="fps"]').forEach((el) => {
  el.addEventListener('change', updateFrameInfo);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    void doCapture();
  }
  if (e.code === 'ArrowLeft' && store.length > 0) {
    store.select(store.selectedIndex - 1);
    renderTimeline();
    updateFrameInfo();
  }
  if (e.code === 'ArrowRight' && store.length > 0) {
    store.select(store.selectedIndex + 1);
    renderTimeline();
    updateFrameInfo();
  }
});

renderTimeline();
updateFrameInfo();
requestAnimationFrame(renderLoop);
