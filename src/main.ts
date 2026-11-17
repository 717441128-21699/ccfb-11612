/**
 * 主逻辑:取景 + 洋葱皮、拍摄与异动提醒、帧编辑(重拍/插帧/删除)、回放、导出。
 */
import './style.css';
import { Compositor } from './compositor';
import { CameraSource } from './capture';
import { FrameStore } from './frames';
import {
  computeStats, compareStats,
  BRIGHTNESS_WARN, SHIFT_WARN_GRID, GRID_W,
} from './analysis';
import { exportMp4 } from './exporter';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 不存在`);
  return el as T;
}

const preview = $<HTMLCanvasElement>('preview');
const cameraSelect = $<HTMLSelectElement>('cameraSelect');
const startCamBtn = $<HTMLButtonElement>('startCam');
const camStatus = $('camStatus');
const toastEl = $('toast');
const modeBadge = $('modeBadge');
const onionEl = $<HTMLInputElement>('onion');
const onionOpacityEl = $<HTMLInputElement>('onionOpacity');
const onionCountEl = $<HTMLSelectElement>('onionCount');
const prevColorEl = $<HTMLInputElement>('prevColor');
const nextColorEl = $<HTMLInputElement>('nextColor');
const captureBtn = $<HTMLButtonElement>('captureBtn');
const pendingInfo = $('pendingInfo');
const selPanel = $('selPanel');
const selIndexEl = $('selIndex');
const retakeBtn = $<HTMLButtonElement>('retakeBtn');
const insertBtn = $<HTMLButtonElement>('insertBtn');
const deleteBtn = $<HTMLButtonElement>('deleteBtn');
const fpsEl = $<HTMLSelectElement>('fps');
const playBtn = $<HTMLButtonElement>('playBtn');
const frameInfo = $('frameInfo');
const exportBtn = $<HTMLButtonElement>('exportBtn');
const exportProgress = $<HTMLProgressElement>('exportProgress');
const exportStatus = $('exportStatus');
const filmstrip = $('filmstrip');

const compositor = new Compositor(preview);
const camera = new CameraSource();
const store = new FrameStore();

type Pending =
  | { kind: 'append' }
  | { kind: 'replace'; index: number }
  | { kind: 'insert'; index: number };

let pending: Pending = { kind: 'append' };
let selected: number | null = null;
let playing = false;
let onionToken = 0;

// ---------------------------------------------------------------- 工具

let toastTimer = 0;
function toast(msg: string, ms = 5000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, ms);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function fps(): number {
  return Number(fpsEl.value);
}

// ---------------------------------------------------------------- 渲染循环

camera.onFrame = (src) => {
  if (!playing) compositor.setBase(src as TexImageSource);
};

function renderLoop() {
  compositor.render();
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ---------------------------------------------------------------- 洋葱皮

/**
 * 当前"落笔位置"前后的参考帧:
 *  - 追加:参考最后几帧,无后帧
 *  - 重拍 i:参考 i 前后
 *  - 插入到 i 后:参考 i 与 i+1 之间
 */
function onionAnchor(): { prevStart: number; nextStart: number } {
  switch (pending.kind) {
    case 'replace': return { prevStart: pending.index - 1, nextStart: pending.index + 1 };
    case 'insert':  return { prevStart: pending.index,     nextStart: pending.index + 1 };
    default:        return { prevStart: store.length - 1,  nextStart: store.length };
  }
}

async function updateOnionSkin() {
  const token = ++onionToken;
  if (!onionEl.checked || playing || store.length === 0) {
    compositor.clearGhosts();
    return;
  }
  const count = Number(onionCountEl.value);      // 前帧 1-3 帧
  const baseOp = Number(onionOpacityEl.value) / 100;
  const [pr, pg, pb] = hexToRgb(prevColorEl.value);
  const [nr, ng, nb] = hexToRgb(nextColorEl.value);
  const { prevStart, nextStart } = onionAnchor();

  // 槽位 0..2 给前帧(近→远),槽位 3 给后一帧
  const jobs: { slot: number; index: number; tint: [number, number, number]; opacity: number }[] = [];
  for (let k = 0; k < count; k++) {
    const idx = prevStart - k;
    if (idx < 0) break;
    jobs.push({ slot: k, index: idx, tint: [pr, pg, pb], opacity: baseOp * Math.pow(0.55, k) });
  }
  if (nextStart < store.length) {
    jobs.push({ slot: 3, index: nextStart, tint: [nr, ng, nb], opacity: baseOp });
  }

  const bitmaps = await Promise.all(
    jobs.map((j) => store.getBitmap(j.index).catch(() => null)),
  );
  if (token !== onionToken) return; // 期间状态变了,丢弃本次结果

  compositor.clearGhosts();
  jobs.forEach((j, i) => {
    const bmp = bitmaps[i];
    if (!bmp) return;
    compositor.setGhostImage(j.slot, bmp);
    compositor.setGhostStyle(j.slot, ...j.tint, j.opacity);
  });
}

[onionEl, onionOpacityEl, onionCountEl, prevColorEl, nextColorEl]
  .forEach((el) => el.addEventListener('input', () => void updateOnionSkin()));

// ---------------------------------------------------------------- 拍摄

/** 拍摄时用于对比的参照帧(前一帧) */
function referenceIndex(): number | null {
  switch (pending.kind) {
    case 'replace': return pending.index > 0 ? pending.index - 1 : null;
    case 'insert':  return pending.index;
    default:        return store.length > 0 ? store.length - 1 : null;
  }
}

async function capture() {
  if (playing || !camera.running || captureBtn.disabled) return;
  captureBtn.disabled = true;
  try {
    const bmp = await camera.captureBitmap();
    const stats = computeStats(bmp, bmp.width, bmp.height);

    // 与前一帧对比:亮度漂移 / 机位移动
    const warnings: string[] = [];
    const refIdx = referenceIndex();
    if (refIdx !== null && store.frames[refIdx]) {
      const cmp = compareStats(store.frames[refIdx].stats, stats);
      const db = cmp.brightnessDelta;
      if (Math.abs(db) > BRIGHTNESS_WARN) {
        warnings.push(`画面亮度${db > 0 ? '变亮' : '变暗'}了 ${((Math.abs(db) / 255) * 100).toFixed(1)}%(检查灯光/曝光)`);
      }
      const mag = Math.hypot(cmp.shiftX, cmp.shiftY);
      if (mag > SHIFT_WARN_GRID) {
        const px = Math.round((mag * camera.width) / GRID_W);
        warnings.push(`机位/布景移动约 ${px}px(桌子可能被碰了)`);
      }
    }

    const frame = await store.makeFrame(bmp, warnings, stats);
    bmp.close();

    let newIndex: number;
    if (pending.kind === 'replace') {
      store.replaceAt(pending.index, frame);
      newIndex = pending.index;
    } else if (pending.kind === 'insert') {
      newIndex = pending.index + 1;
      store.insertAt(newIndex, frame);
    } else {
      store.append(frame);
      newIndex = store.length - 1;
    }

    selected = newIndex;
    pending = { kind: 'append' };
    refreshUI();
    if (warnings.length) toast('⚠ ' + warnings.join(';'));
  } catch (e) {
    toast('拍摄失败:' + (e as Error).message);
  } finally {
    captureBtn.disabled = !camera.running;
  }
}

captureBtn.addEventListener('click', () => void capture());
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && (e.target === document.body || e.target === preview)) {
    e.preventDefault();
    void capture();
  }
});

// ---------------------------------------------------------------- 帧选择与编辑

function refreshFilmstrip() {
  filmstrip.textContent = '';
  if (store.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有帧,先拍一张吧';
    filmstrip.appendChild(empty);
    return;
  }
  store.frames.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'thumb' + (i === selected ? ' selected' : '');
    const img = document.createElement('img');
    img.src = f.thumbUrl;
    img.alt = `第 ${i + 1} 帧`;
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    div.append(img, idx);
    if (f.warnings.length) {
      const warn = document.createElement('span');
      warn.className = 'warn';
      warn.textContent = '⚠️';
      warn.title = f.warnings.join('\n');
      div.appendChild(warn);
    }
    div.addEventListener('click', () => {
      selected = i;
      refreshUI();
    });
    filmstrip.appendChild(div);
  });
  // 滚动到选中帧
  filmstrip.querySelector('.thumb.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updatePendingUI() {
  const hasSel = selected !== null && selected < store.length;
  selPanel.hidden = !hasSel;
  if (hasSel) selIndexEl.textContent = String(selected! + 1);

  retakeBtn.classList.toggle('armed', pending.kind === 'replace');
  insertBtn.classList.toggle('armed', pending.kind === 'insert');

  switch (pending.kind) {
    case 'replace':
      pendingInfo.textContent = `下一次拍摄:替换第 ${pending.index + 1} 帧(对着洋葱皮摆位)`;
      break;
    case 'insert':
      pendingInfo.textContent = `下一次拍摄:插入到第 ${pending.index + 1} 帧之后`;
      break;
    default:
      pendingInfo.textContent = '下一帧:追加到末尾';
  }
}

function refreshUI() {
  refreshFilmstrip();
  updatePendingUI();
  frameInfo.textContent = `共 ${store.length} 帧(约 ${(store.length / fps()).toFixed(1)} 秒)`;
  playBtn.disabled = store.length === 0 || playing;
  exportBtn.disabled = store.length === 0;
  void updateOnionSkin();
}

retakeBtn.addEventListener('click', () => {
  if (selected === null) return;
  pending = pending.kind === 'replace' ? { kind: 'append' } : { kind: 'replace', index: selected };
  updatePendingUI();
  void updateOnionSkin();
});

insertBtn.addEventListener('click', () => {
  if (selected === null) return;
  pending = pending.kind === 'insert' ? { kind: 'append' } : { kind: 'insert', index: selected };
  updatePendingUI();
  void updateOnionSkin();
});

deleteBtn.addEventListener('click', () => {
  if (selected === null) return;
  store.removeAt(selected);
  selected = selected >= store.length ? store.length - 1 : selected;
  if (store.length === 0) selected = null;
  pending = { kind: 'append' };
  refreshUI();
});

fpsEl.addEventListener('change', refreshUI);

// ---------------------------------------------------------------- 回放

let playTimer = 0;
let playBusy = false;

async function playStep(i: number): Promise<void> {
  const bmp = await store.getBitmap(i);
  if (!playing) return;
  compositor.setBase(bmp);
  frameInfo.textContent = `回放 第 ${i + 1}/${store.length} 帧 @ ${fps()}fps`;
  for (let k = 1; k <= 3; k++) store.prefetch(i + k); // 预解码后面几帧
}

async function togglePlay() {
  if (playing) {
    stopPlayback();
    return;
  }
  if (store.length === 0) return;
  playing = true;
  playBtn.textContent = '停止';
  modeBadge.textContent = '回放';
  captureBtn.disabled = true;
  playBtn.disabled = false;
  compositor.clearGhosts();

  let i = 0;
  await playStep(i++);
  playTimer = window.setInterval(() => {
    if (playBusy) return; // 解码跟不上就跳一拍,不堆积
    playBusy = true;
    void playStep(i).finally(() => { playBusy = false; });
    i = (i + 1) % store.length;
  }, 1000 / fps());
}

function stopPlayback() {
  playing = false;
  clearInterval(playTimer);
  playBtn.textContent = '回放';
  modeBadge.textContent = '取景';
  captureBtn.disabled = !camera.running;
  refreshUI();
}

playBtn.addEventListener('click', () => void togglePlay());

// ---------------------------------------------------------------- 导出

exportBtn.addEventListener('click', async () => {
  if (store.length === 0 || exportBtn.disabled) return;
  if (playing) stopPlayback();
  exportBtn.disabled = true;
  exportProgress.value = 0;
  const t0 = performance.now();
  try {
    exportStatus.textContent = '导出中…';
    const blob = await exportMp4(
      (i) => store.getBitmap(i),
      store.length,
      fps(),
      (done, total) => {
        exportProgress.value = done / total;
        exportStatus.textContent = `导出中 ${done}/${total} 帧`;
      },
    );
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stopmotion_${store.length}帧_${fps()}fps.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    exportStatus.textContent = `完成:${store.length} 帧用时 ${secs}s,${(blob.size / 1048576).toFixed(1)} MB`;
    toast(`导出完成,用时 ${secs} 秒`);
  } catch (e) {
    exportStatus.textContent = '导出失败';
    toast('导出失败:' + (e as Error).message);
  } finally {
    exportBtn.disabled = false;
  }
});

// ---------------------------------------------------------------- 摄像头

async function refreshCameraList() {
  const cams = await CameraSource.listCameras();
  cameraSelect.textContent = '';
  cams.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = c.deviceId;
    opt.textContent = c.label || `摄像头 ${i + 1}`;
    cameraSelect.appendChild(opt);
  });
}

startCamBtn.addEventListener('click', async () => {
  startCamBtn.disabled = true;
  try {
    if (camera.running) {
      await camera.stop();
      startCamBtn.textContent = '连接摄像头';
      camStatus.textContent = '未连接';
      captureBtn.disabled = true;
      return;
    }
    await camera.start(cameraSelect.value || undefined);
    compositor.resize(camera.width, camera.height);
    camStatus.textContent = `${camera.width}×${camera.height}`;
    startCamBtn.textContent = '断开';
    captureBtn.disabled = false;
    await refreshCameraList(); // 拿到权限后设备名才可见
    toast(`摄像头已连接:${camera.width}×${camera.height}`);
  } catch (e) {
    toast('摄像头启动失败:' + (e as Error).message);
    camStatus.textContent = '连接失败';
  } finally {
    startCamBtn.disabled = false;
  }
});

void refreshCameraList().catch(() => undefined);
refreshUI();
