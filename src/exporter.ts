/**
 * 视频导出：WebCodecs VideoEncoder（优先硬件编码）输出 H.264，
 * mp4-muxer 封装为 MP4。1080p 下硬件编码通常可达数百 fps，
 * 300 帧导出（解码 JPEG + 编码 + 封装）一般在几秒内完成。
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { FrameStore, FRAME_W, FRAME_H } from './store';

// 1080p 需要 H.264 Level 4.0+；按优先级尝试
const CODEC_CANDIDATES = [
  'avc1.640028', // High 4.0
  'avc1.4d0028', // Main 4.0
  'avc1.42e028', // Baseline 4.0
  'avc1.64002a', // High 4.2
];

async function pickCodec(fps: number): Promise<VideoEncoderConfig> {
  for (const codec of CODEC_CANDIDATES) {
    const config: VideoEncoderConfig = {
      codec,
      width: FRAME_W,
      height: FRAME_H,
      bitrate: 10_000_000,
      framerate: fps,
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware',
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      // 尝试下一个
    }
  }
  throw new Error('当前浏览器不支持 1080p H.264 硬件编码，无法导出 MP4');
}

export async function exportMp4(
  store: FrameStore,
  fps: number,
  onProgress: (done: number, total: number) => void,
): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('当前浏览器不支持 WebCodecs，请使用最新版 Chrome / Edge');
  }
  const total = store.length;
  if (total === 0) throw new Error('还没有拍摄任何帧');

  const config = await pickCodec(fps);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: FRAME_W, height: FRAME_H, frameRate: fps },
    fastStart: 'in-memory',
  });

  let encodeError: DOMException | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e;
    },
  });
  encoder.configure(config);

  const frameDuration = 1_000_000 / fps;
  for (let i = 0; i < total; i++) {
    if (encodeError) throw encodeError;
    const frame = store.at(i)!;
    const bmp = await store.bitmap(frame);
    const vf = new VideoFrame(bmp, {
      timestamp: Math.round(i * frameDuration),
      duration: Math.round(frameDuration),
    });
    // 每 2 秒一个关键帧
    encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
    onProgress(i + 1, total);
    // 背压：编码队列别堆太深
    while (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;

  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
