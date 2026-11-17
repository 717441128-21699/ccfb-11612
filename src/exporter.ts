/**
 * 视频导出:WebCodecs VideoEncoder 硬编 H.264 + mp4-muxer 封装 MP4。
 * 1080p / 12 或 24 fps,逐帧解码 → 缩放贴到 1920×1080 → 编码,带背压控制。
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const OUT_W = 1920;
const OUT_H = 1080;
const BITRATE = 12_000_000;

export interface ExportProgress {
  (done: number, total: number): void;
}

async function pickConfig(): Promise<VideoEncoderConfig> {
  // High/Main/Baseline @ Level 4.0(1080p30 足够,24fps 裕量很大)
  const codecs = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'];
  for (const codec of codecs) {
    const config: VideoEncoderConfig = {
      codec,
      width: OUT_W,
      height: OUT_H,
      bitrate: BITRATE,
      framerate: 24,
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware',
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      /* 尝试下一个 */
    }
  }
  throw new Error('当前环境不支持 H.264 硬件编码,无法导出 MP4');
}

export async function exportMp4(
  getFrame: (index: number) => Promise<ImageBitmap>,
  count: number,
  fps: number,
  onProgress?: ExportProgress,
): Promise<Blob> {
  const config = await pickConfig();
  config.framerate = fps;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: OUT_W, height: OUT_H },
    fastStart: 'in-memory',
  });

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  encoder.configure(config);

  // 导出画布:源帧按比例放大铺满 1080p(cover),黑边兜底
  const canvas = new OffscreenCanvas(OUT_W, OUT_H);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';

  const frameDuration = Math.round(1_000_000 / fps);

  for (let i = 0; i < count; i++) {
    if (encodeError) throw encodeError;
    // 背压:编码队列别堆太深,控制内存
    while (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 2));
      if (encodeError) throw encodeError;
    }

    const bmp = await getFrame(i);
    const scale = Math.max(OUT_W / bmp.width, OUT_H / bmp.height);
    const dw = bmp.width * scale;
    const dh = bmp.height * scale;
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    ctx.drawImage(bmp, (OUT_W - dw) / 2, (OUT_H - dh) / 2, dw, dh);

    const vf = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1_000_000) / fps),
      duration: frameDuration,
    });
    encoder.encode(vf, { keyFrame: i % 120 === 0 });
    vf.close();
    onProgress?.(i + 1, count);
  }

  await encoder.flush();
  if (encodeError) throw encodeError;
  encoder.close();
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
