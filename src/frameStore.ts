/**
 * 帧数据仓库:保存所有已拍帧,支持插入 / 替换 / 删除。
 * 每帧保存:
 *  - bitmap:    全分辨率 ImageBitmap(用于回放与导出)
 *  - thumbUrl:  时间轴缩略图 dataURL
 *  - gray:      64x36 灰度分析图(用于亮度 / 位移检测)
 *  - warnings:  拍摄时与前一帧比较产生的告警
 */

export const ANALYSIS_W = 64;
export const ANALYSIS_H = 36;

export interface FrameWarning {
  kind: 'brightness' | 'shift';
  message: string;
}

export interface StoredFrame {
  id: number;
  bitmap: ImageBitmap;
  thumbUrl: string;
  /** 64x36 灰度,0-255 */
  gray: Uint8Array;
  meanLuma: number;
  warnings: FrameWarning[];
}

let nextId = 1;

const thumbCanvas = document.createElement('canvas');
const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true })!;

/** 从 ImageBitmap 生成灰度分析图与平均亮度 */
function analyze(bitmap: ImageBitmap): { gray: Uint8Array; meanLuma: number } {
  thumbCanvas.width = ANALYSIS_W;
  thumbCanvas.height = ANALYSIS_H;
  thumbCtx.drawImage(bitmap, 0, 0, ANALYSIS_W, ANALYSIS_H);
  const { data } = thumbCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
  const gray = new Uint8Array(ANALYSIS_W * ANALYSIS_H);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    // Rec.601 亮度
    const y = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
    gray[i] = y;
    sum += y;
  }
  return { gray, meanLuma: sum / gray.length };
}

function makeThumbUrl(bitmap: ImageBitmap): string {
  const w = 160;
  const h = Math.round((bitmap.height / bitmap.width) * w);
  thumbCanvas.width = w;
  thumbCanvas.height = h;
  thumbCtx.drawImage(bitmap, 0, 0, w, h);
  return thumbCanvas.toDataURL('image/jpeg', 0.7);
}

export function createFrame(bitmap: ImageBitmap): StoredFrame {
  const { gray, meanLuma } = analyze(bitmap);
  return {
    id: nextId++,
    bitmap,
    thumbUrl: makeThumbUrl(bitmap),
    gray,
    meanLuma,
    warnings: [],
  };
}

export class FrameStore {
  frames: StoredFrame[] = [];
  /** 当前选中帧下标;-1 表示"末尾"(拍摄模式默认) */
  selected = -1;

  get length(): number {
    return this.frames.length;
  }

  get selectedIndex(): number {
    if (this.selected < 0 || this.selected >= this.frames.length) {
      return this.frames.length - 1;
    }
    return this.selected;
  }

  at(i: number): StoredFrame | undefined {
    return this.frames[i];
  }

  /** 追加一帧(拍摄) */
  append(frame: StoredFrame): number {
    this.frames.push(frame);
    this.selected = this.frames.length - 1;
    return this.selected;
  }

  /** 在 index 之后插入一帧 */
  insertAfter(index: number, frame: StoredFrame): number {
    const at = Math.min(Math.max(index + 1, 0), this.frames.length);
    this.frames.splice(at, 0, frame);
    this.selected = at;
    return at;
  }

  /** 替换 index 处的帧,释放旧位图 */
  replace(index: number, frame: StoredFrame): void {
    const old = this.frames[index];
    if (!old) return;
    this.frames[index] = frame;
    old.bitmap.close();
    this.selected = index;
  }

  delete(index: number): void {
    const old = this.frames[index];
    if (!old) return;
    this.frames.splice(index, 1);
    old.bitmap.close();
    this.selected = Math.min(index, this.frames.length - 1);
  }

  select(index: number): void {
    this.selected = Math.min(Math.max(index, -1), this.frames.length - 1);
  }
}
