/**
 * 帧异动检测:把画面降采样到 64×36 灰度网格,
 *  - 亮度:两帧平均亮度差(灯光闪烁/曝光漂移)
 *  - 位移:在小范围内做平移搜索(SAD 最小化),检出桌子被碰歪/机位移动
 */

export const GRID_W = 64;
export const GRID_H = 36;

/** 亮度告警阈值(0-255 灰度级) */
export const BRIGHTNESS_WARN = 8;
/** 位移告警阈值(网格像素,1 格 ≈ 全宽的 1/64) */
export const SHIFT_WARN_GRID = 1.2;

export interface FrameStats {
  /** 平均亮度 0-255 */
  mean: number;
  /** 灰度网格,行优先 */
  grid: Uint8Array;
}

export interface CompareResult {
  /** curr.mean - prev.mean */
  brightnessDelta: number;
  /** 估计位移(网格像素,正数表示画面内容向右/下移动) */
  shiftX: number;
  shiftY: number;
}

let workCanvas: OffscreenCanvas | null = null;
let workCtx: OffscreenCanvasRenderingContext2D | null = null;

export function computeStats(source: CanvasImageSource, srcW: number, srcH: number): FrameStats {
  if (!workCanvas) {
    workCanvas = new OffscreenCanvas(GRID_W, GRID_H);
    workCtx = workCanvas.getContext('2d', { willReadFrequently: true })!;
  }
  workCtx!.drawImage(source as CanvasImageSource & HTMLElement, 0, 0, srcW, srcH, 0, 0, GRID_W, GRID_H);
  const data = workCtx!.getImageData(0, 0, GRID_W, GRID_H).data;
  const grid = new Uint8Array(GRID_W * GRID_H);
  let sum = 0;
  for (let i = 0; i < grid.length; i++) {
    const o = i * 4;
    const lum = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
    grid[i] = lum;
    sum += lum;
  }
  return { mean: sum / grid.length, grid };
}

const MAX_DX = 6;
const MAX_DY = 4;

export function compareStats(prev: FrameStats, curr: FrameStats): CompareResult {
  // 平移搜索:对每个 (dx,dy) 计算重叠区域的平均绝对差,取最小
  let best = Infinity;
  let bestDx = 0;
  let bestDy = 0;
  const a = prev.grid;
  const b = curr.grid;

  for (let dy = -MAX_DY; dy <= MAX_DY; dy++) {
    for (let dx = -MAX_DX; dx <= MAX_DX; dx++) {
      let sad = 0;
      let count = 0;
      const y0 = Math.max(0, dy);
      const y1 = Math.min(GRID_H, GRID_H + dy);
      const x0 = Math.max(0, dx);
      const x1 = Math.min(GRID_W, GRID_W + dx);
      for (let y = y0; y < y1; y++) {
        const rowA = y * GRID_W;
        const rowB = (y - dy) * GRID_W;
        for (let x = x0; x < x1; x++) {
          sad += Math.abs(a[rowA + x] - b[rowB + (x - dx)]);
          count++;
        }
      }
      const mean = sad / count;
      if (mean < best) {
        best = mean;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return {
    brightnessDelta: curr.mean - prev.mean,
    shiftX: bestDx,
    shiftY: bestDy,
  };
}
