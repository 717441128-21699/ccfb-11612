/**
 * 视频导出:WebCodecs VideoEncoder (H.264) + mp4-muxer 封装。
 * 输出固定 1920x1080,帧按比例缩放居中(留黑边)。
 * 300 帧在硬件编码下通常 5-10 秒内完成。
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { StoredFrame } from './frameStore';

const OUT_W = 1920;
const OUT_H = 1080;

export interface ExportProgress {
  encoded: number;
  total: number;
}

export async function exportMp4(
  frames: StoredFrame[],
  fps: number,
  onProgress: (p: ExportProgress) => void,
): Promise<Blob> {
  if (frames.length === 0) throw new Error('没有可导出的帧');
  if (typeof VideoEncoder === 'undefined') throw new Error('当前浏览器不支持 WebCodecs');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: OUT_W, height: OUT_H, frameRate: fps },
    fastStart: 'in-memory',
  });

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  encoder.configure({
    codec: 'avc1.640028', // H.264 High @ L4.0,支持 1080p30
    width: OUT_W,
    height: OUT_H,
    bitrate: 10_000_000,
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
  });

  // 离屏画布负责把每帧等比缩放到 1080p
  const canvas = new OffscreenCanvas(OUT_W, OUT_H);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.imageSmoothingQuality = 'high';

  const frameDuration = 1_000_000 / fps; // 微秒

  for (let i = 0; i < frames.length; i++) {
    if (encodeError) throw encodeError;
    const bmp = frames[i].bitmap;
    const scale = Math.min(OUT_W / bmp.width, OUT_H / bmp.height);
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    ctx.drawImage(bmp, (OUT_W - w) / 2, (OUT_H - h) / 2, w, h);

    const vf = new VideoFrame(canvas, {
      timestamp: Math.round(i * frameDuration),
      duration: Math.round(frameDuration),
    });
    encoder.encode(vf, { keyFrame: i % 60 === 0 });
    vf.close();

    // 编码队列别压太深,让编码器喘息
    if (encoder.encodeQueueSize > 8) {
      await new Promise<void>((resolve) => {
        encoder.addEventListener('dequeue', () => resolve(), { once: true });
      });
    }
    onProgress({ encoded: i + 1, total: frames.length });
  }

  await encoder.flush();
  if (encodeError) throw encodeError;
  encoder.close();
  muxer.finalize();

  const { buffer } = muxer.target as ArrayBufferTarget;
  return new Blob([buffer], { type: 'video/mp4' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
