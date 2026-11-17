/**
 * 帧仓库:管理已拍帧的存储、增删替换、解码缓存。
 *
 * 内存策略:每帧以 JPEG blob 持久(300 帧 1080p 的原始位图约 2.5GB,不能全留内存),
 * 解码出的 ImageBitmap 走 LRU 缓存(洋葱皮/回放/导出会反复取相邻帧)。
 */

import type { FrameStats } from './analysis';

export interface StoredFrame {
  id: number;
  blob: Blob;
  thumbUrl: string;
  warnings: string[];
  stats: FrameStats;
}

const CACHE_MAX = 24;
const JPEG_QUALITY = 0.92;
const THUMB_W = 160;

export class FrameStore {
  frames: StoredFrame[] = [];
  private nextId = 1;
  /** key: frame id;Map 迭代顺序即 LRU 顺序 */
  private cache = new Map<number, ImageBitmap>();

  get length() {
    return this.frames.length;
  }

  /** 把刚拍的位图做成一帧(编码 JPEG + 生成缩略图) */
  async makeFrame(source: ImageBitmap, warnings: string[], stats: FrameStats): Promise<StoredFrame> {
    const w = source.width;
    const h = source.height;
    const full = new OffscreenCanvas(w, h);
    full.getContext('2d')!.drawImage(source, 0, 0);
    const blob = await full.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });

    const thumbH = Math.max(1, Math.round((THUMB_W * h) / w));
    const thumb = new OffscreenCanvas(THUMB_W, thumbH);
    thumb.getContext('2d')!.drawImage(source, 0, 0, THUMB_W, thumbH);
    const thumbBlob = await thumb.convertToBlob({ type: 'image/jpeg', quality: 0.7 });

    return {
      id: this.nextId++,
      blob,
      thumbUrl: URL.createObjectURL(thumbBlob),
      warnings,
      stats,
    };
  }

  append(frame: StoredFrame) {
    this.frames.push(frame);
  }

  insertAt(index: number, frame: StoredFrame) {
    this.frames.splice(index, 0, frame);
  }

  replaceAt(index: number, frame: StoredFrame) {
    const old = this.frames[index];
    if (old) this.dispose(old);
    this.frames[index] = frame;
  }

  removeAt(index: number) {
    const [old] = this.frames.splice(index, 1);
    if (old) this.dispose(old);
  }

  /** 取第 index 帧的解码位图(带 LRU 缓存,供洋葱皮/回放/导出使用) */
  async getBitmap(index: number): Promise<ImageBitmap> {
    const frame = this.frames[index];
    if (!frame) throw new Error(`帧 #${index} 不存在`);
    const hit = this.cache.get(frame.id);
    if (hit) {
      // 刷新 LRU 热度
      this.cache.delete(frame.id);
      this.cache.set(frame.id, hit);
      return hit;
    }
    const bmp = await createImageBitmap(frame.blob);
    this.cache.set(frame.id, bmp);
    while (this.cache.size > CACHE_MAX) {
      const oldestKey = this.cache.keys().next().value!;
      this.cache.get(oldestKey)!.close();
      this.cache.delete(oldestKey);
    }
    return bmp;
  }

  /** 预取(不回结果,只暖缓存) */
  prefetch(index: number) {
    if (index >= 0 && index < this.frames.length) {
      void this.getBitmap(index).catch(() => undefined);
    }
  }

  private dispose(frame: StoredFrame) {
    URL.revokeObjectURL(frame.thumbUrl);
    const bmp = this.cache.get(frame.id);
    if (bmp) {
      bmp.close();
      this.cache.delete(frame.id);
    }
  }
}
