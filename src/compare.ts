/**
 * 帧间比对：每拍一帧就和前一帧比较，检测两类常见问题——
 *  1. 整体亮度变化（灯光闪烁、曝光漂移）
 *  2. 相机/桌子被碰（画面整体平移、全画面大面积变化）
 *
 * 做法：把帧降到 96×54 灰度；先比亮度均值，再做小范围整数平移搜索
 * （对齐残差显著下降且位移非零 → 场景被碰动），最后按分块统计
 * 变化区域占比（人偶动作只影响局部，碰桌子会影响全画面）。
 */

export interface GrayFrame {
  w: number;
  h: number;
  data: Float32Array;
  mean: number;
}

export const GRAY_W = 96;
export const GRAY_H = 54;

let grayCanvas: OffscreenCanvas | null = null;

export function toGray(source: CanvasImageSource): GrayFrame {
  if (!grayCanvas) grayCanvas = new OffscreenCanvas(GRAY_W, GRAY_H);
  const ctx = grayCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, GRAY_W, GRAY_H);
  const img = ctx.getImageData(0, 0, GRAY_W, GRAY_H).data;
  const data = new Float32Array(GRAY_W * GRAY_H);
  let sum = 0;
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const v = 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
    data[i] = v;
    sum += v;
  }
  return { w: GRAY_W, h: GRAY_H, data, mean: sum / data.length };
}

export interface CompareResult {
  /** 亮度均值差（新帧 - 旧帧，0-255 量纲） */
  dBrightness: number;
  /** 最佳对齐位移（降采样像素，1px ≈ 全分辨率 20px） */
  shiftX: number;
  shiftY: number;
  /** 未对齐 / 对齐后的平均绝对差 */
  baseResidual: number;
  alignedResidual: number;
  /** 对齐后仍显著变化的分块占比 0..1 */
  globalBlockRatio: number;
  warnings: string[];
}

const SEARCH_RANGE = 6; // 降采样像素，±6 ≈ 全分辨率 ±120px
const BRIGHTNESS_THRESHOLD = 4;
const SHIFT_THRESHOLD = 2;
const BLOCK_COLS = 12;
const BLOCK_ROWS = 7;
const BLOCK_DIFF_THRESHOLD = 10;
const GLOBAL_RATIO_THRESHOLD = 0.5;

/** 计算 prev 相对 cur 平移 (dx,dy) 后的亮度归一化平均绝对差 */
function alignedMAD(prev: GrayFrame, cur: GrayFrame, dx: number, dy: number): number {
  const { w, h } = prev;
  const x0 = Math.max(0, -dx);
  const x1 = Math.min(w, w - dx);
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(h, h - dy);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const rowA = y * w;
    const rowB = (y + dy) * w;
    for (let x = x0; x < x1; x++) {
      sum += Math.abs((prev.data[rowA + x] - prev.mean) - (cur.data[rowB + x + dx] - cur.mean));
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

export function compareFrames(prev: GrayFrame, cur: GrayFrame): CompareResult {
  const dBrightness = cur.mean - prev.mean;

  // 小范围平移搜索，找最佳对齐
  let best = Infinity;
  let shiftX = 0;
  let shiftY = 0;
  for (let dy = -SEARCH_RANGE; dy <= SEARCH_RANGE; dy++) {
    for (let dx = -SEARCH_RANGE; dx <= SEARCH_RANGE; dx++) {
      const mad = alignedMAD(prev, cur, dx, dy);
      if (mad < best) {
        best = mad;
        shiftX = dx;
        shiftY = dy;
      }
    }
  }
  const baseResidual = alignedMAD(prev, cur, 0, 0);
  const alignedResidual = best;

  // 对齐后按分块统计仍显著变化的区域占比
  const { w, h } = prev;
  const bw = Math.floor(w / BLOCK_COLS);
  const bh = Math.floor(h / BLOCK_ROWS);
  let changed = 0;
  for (let by = 0; by < BLOCK_ROWS; by++) {
    for (let bx = 0; bx < BLOCK_COLS; bx++) {
      let sum = 0;
      let n = 0;
      for (let y = by * bh; y < (by + 1) * bh; y++) {
        for (let x = bx * bw; x < (bx + 1) * bw; x++) {
          const cx = x + shiftX;
          const cy = y + shiftY;
          if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
          sum += Math.abs(
            (prev.data[y * w + x] - prev.mean) - (cur.data[cy * w + cx] - cur.mean),
          );
          n++;
        }
      }
      if (n > 0 && sum / n > BLOCK_DIFF_THRESHOLD) changed++;
    }
  }
  const globalBlockRatio = changed / (BLOCK_COLS * BLOCK_ROWS);

  const warnings: string[] = [];
  if (Math.abs(dBrightness) >= BRIGHTNESS_THRESHOLD) {
    warnings.push(
      `⚠ 画面亮度变化 ${dBrightness > 0 ? '+' : ''}${dBrightness.toFixed(1)}（0-255），检查灯光或相机曝光`,
    );
  }
  const shiftMag = Math.hypot(shiftX, shiftY);
  // 对齐后残差显著下降才算“整体被移动”，避免把人偶大动作误判为碰机位
  if (shiftMag >= SHIFT_THRESHOLD && alignedResidual < baseResidual * 0.7) {
    const fx = Math.round(shiftX * (1920 / GRAY_W));
    const fy = Math.round(shiftY * (1080 / GRAY_H));
    warnings.push(`⚠ 画面整体偏移约 (${fx}, ${fy}) 像素，相机或桌子可能被碰动`);
  }
  if (globalBlockRatio >= GLOBAL_RATIO_THRESHOLD) {
    warnings.push('⚠ 超过一半的画面区域发生变化，场景可能被移动或光线突变');
  }

  return { dBrightness, shiftX, shiftY, baseResidual, alignedResidual, globalBlockRatio, warnings };
}
