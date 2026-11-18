/**
 * 帧存储：
 *  - 拍摄源（摄像头帧）统一归一化到 1920×1080，编码为 JPEG Blob 持久保存
 *    （300 帧 × ~300KB ≈ 90MB，内存可控；原始位图不常驻）
 *  - 每帧同时生成时间线缩略图（dataURL）和比对用灰度图
 *  - ImageBitmap 按需从 Blob 解码，LRU 缓存（洋葱皮 / 回放 / 导出共用）
 */

import { GrayFrame, toGray } from './compare';

export const FRAME_W = 1920;
export const FRAME_H = 1080;

export interface Frame {
  id: number;
  blob: Blob;
  thumb: string;
  gray: GrayFrame;
}

const BITMAP_CACHE_LIMIT = 16;

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export class FrameStore {
  frames: Frame[] = [];
  private nextId = 1;
  private cache = new Map<number, ImageBitmap>();
  private listeners = new Set<() => void>();
  private workCanvas = new OffscreenCanvas(FRAME_W, FRAME_H);
  private thumbCanvas = new OffscreenCanvas(160, 90);

  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /** 把拍摄源归一化为 1920×1080 的一帧 */
  async createFrame(source: CanvasImageSource): Promise<Frame> {
    const ctx = this.workCanvas.getContext('2d')!;
    ctx.drawImage(source, 0, 0, FRAME_W, FRAME_H);
    const blob = await this.workCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });

    const tctx = this.thumbCanvas.getContext('2d')!;
    tctx.drawImage(this.workCanvas, 0, 0, this.thumbCanvas.width, this.thumbCanvas.height);
    const thumbBlob = await this.thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const thumb = await blobToDataURL(thumbBlob);

    const gray = toGray(this.workCanvas);
    return { id: this.nextId++, blob, thumb, gray };
  }

  insertAt(index: number, frame: Frame): void {
    this.frames.splice(index, 0, frame);
    this.emit();
  }

  replaceAt(index: number, frame: Frame): void {
    const old = this.frames[index];
    if (old) this.evict(old.id);
    this.frames[index] = frame;
    this.emit();
  }

  removeAt(index: number): void {
    const [old] = this.frames.splice(index, 1);
    if (old) this.evict(old.id);
    this.emit();
  }

  get length(): number {
    return this.frames.length;
  }

  at(index: number): Frame | undefined {
    return this.frames[index];
  }

  /** 解码并缓存位图（LRU） */
  async bitmap(frame: Frame): Promise<ImageBitmap> {
    const hit = this.cache.get(frame.id);
    if (hit) {
      this.cache.delete(frame.id);
      this.cache.set(frame.id, hit);
      return hit;
    }
    const bmp = await createImageBitmap(frame.blob);
    this.cache.set(frame.id, bmp);
    while (this.cache.size > BITMAP_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value!;
      if (oldest === frame.id) break; // 至少保留刚解码的这张
      this.evict(oldest);
    }
    return bmp;
  }

  private evict(id: number): void {
    const bmp = this.cache.get(id);
    if (bmp) {
      bmp.close();
      this.cache.delete(id);
    }
  }
}
