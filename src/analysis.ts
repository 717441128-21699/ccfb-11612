/**
 * 拍摄质量检测:每拍一帧,与前一帧比较。
 *  1. 亮度突变 —— 平均亮度差超过阈值(灯被动了 / 曝光漂移)
 *  2. 机位 / 桌面位移 —— 在 64x36 灰度图上做整数像素块匹配(SAD 搜索),
 *     若最佳位移非零且显著优于零位移,说明相机或桌子被碰了。
 */

import { ANALYSIS_W, ANALYSIS_H, StoredFrame, FrameWarning } from './frameStore';

/** 平均亮度差阈值(0-255),约 2.4% 亮度变化 */
export const LUMA_THRESHOLD = 6;
/** 位移搜索半径(分析图像素,64x36 图上 ±6 ≈ 1080p 上 ±180px) */
const SEARCH_RADIUS = 6;
/** 最佳位移相对零位移的 SAD 改善比例,超过才判定为位移 */
const SAD_IMPROVEMENT = 0.12;
/** 位移多少像素(分析图)以上才报警,过滤手抖级别的 1px */
const MIN_SHIFT_PX = 2;

function sadAtOffset(a: Uint8Array, b: Uint8Array, dx: number, dy: number): number {
  // b 相对 a 平移 (dx, dy);只比较重叠区域
  const x0 = Math.max(0, dx);
  const x1 = Math.min(ANALYSIS_W, ANALYSIS_W + dx);
  const y0 = Math.max(0, dy);
  const y1 = Math.min(ANALYSIS_H, ANALYSIS_H + dy);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const rowA = y * ANALYSIS_W;
    const rowB = (y - dy) * ANALYSIS_W;
    for (let x = x0; x < x1; x++) {
      sum += Math.abs(a[rowA + x] - b[rowB + (x - dx)]);
      n++;
    }
  }
  return n === 0 ? Infinity : sum / n;
}

export interface ShiftResult {
  dx: number;
  dy: number;
  improvement: number;
}

export function estimateShift(prev: Uint8Array, curr: Uint8Array): ShiftResult {
  const base = sadAtOffset(prev, curr, 0, 0);
  let best = base;
  let bdx = 0;
  let bdy = 0;
  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      if (dx === 0 && dy === 0) continue;
      const s = sadAtOffset(prev, curr, dx, dy);
      if (s < best) {
        best = s;
        bdx = dx;
        bdy = dy;
      }
    }
  }
  const improvement = base > 0 && isFinite(base) ? (base - best) / base : 0;
  return { dx: bdx, dy: bdy, improvement };
}

/** 比较新帧与前一帧,返回告警列表 */
export function compareFrames(prev: StoredFrame, curr: StoredFrame): FrameWarning[] {
  const warnings: FrameWarning[] = [];

  const lumaDiff = curr.meanLuma - prev.meanLuma;
  if (Math.abs(lumaDiff) > LUMA_THRESHOLD) {
    warnings.push({
      kind: 'brightness',
      message: `画面亮度${lumaDiff > 0 ? '变亮' : '变暗'}了 ${Math.abs(lumaDiff).toFixed(1)} 级,检查灯光或曝光`,
    });
  }

  const shift = estimateShift(prev.gray, curr.gray);
  const mag = Math.hypot(shift.dx, shift.dy);
  if (mag >= MIN_SHIFT_PX && shift.improvement > SAD_IMPROVEMENT) {
    warnings.push({
      kind: 'shift',
      message: `机位/桌面疑似移动 (${shift.dx > 0 ? '→' : shift.dx < 0 ? '←' : ''}${shift.dy > 0 ? '↓' : shift.dy < 0 ? '↑' : ''} 约 ${mag.toFixed(1)}px),建议重拍`,
    });
  }

  return warnings;
}
