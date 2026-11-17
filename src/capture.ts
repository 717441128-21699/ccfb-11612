/**
 * 摄像头采集。
 * 优先走 WebCodecs 路径:MediaStreamTrackProcessor 直接产出 VideoFrame;
 * 不支持的浏览器回退到 <video> + requestVideoFrameCallback。
 */

export type FrameSource = VideoFrame | HTMLVideoElement;

export class CameraSource {
  /** 最新一帧(仅 WebCodecs 路径;回调触发间隙可用于拍照) */
  latest: VideoFrame | null = null;
  /** 每收到新一帧回调(用于刷新预览纹理) */
  onFrame: ((src: FrameSource) => void) | null = null;

  width = 0;
  height = 0;
  running = false;

  private stream: MediaStream | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private video: HTMLVideoElement | null = null;
  private usingProcessor = false;

  async start(deviceId?: string) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      audio: false,
    });
    const track = this.stream.getVideoTracks()[0];
    const settings = track.getSettings();
    this.width = settings.width ?? 1280;
    this.height = settings.height ?? 720;

    const MTP = (globalThis as Record<string, unknown>)['MediaStreamTrackProcessor'] as
      (new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }) | undefined;

    if (MTP) {
      this.usingProcessor = true;
      const processor = new MTP({ track });
      this.reader = processor.readable.getReader();
      void this.pump();
    } else {
      // 回退路径:video 元素逐帧回调
      const v = document.createElement('video');
      v.muted = true;
      v.srcObject = this.stream;
      await v.play();
      this.video = v;
      const loop = () => {
        if (!this.running) return;
        this.onFrame?.(v);
        (v as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void })
          .requestVideoFrameCallback(loop);
      };
      (v as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void })
        .requestVideoFrameCallback(loop);
    }
    this.running = true;
  }

  private async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        const old = this.latest;
        this.latest = value;
        this.onFrame?.(value);
        old?.close();
      }
    } catch {
      /* 读取取消/轨道结束 */
    }
  }

  /** 抓取当前画面为 ImageBitmap(拍照瞬间的画面拷贝) */
  async captureBitmap(): Promise<ImageBitmap> {
    if (this.usingProcessor) {
      if (!this.latest) throw new Error('还没有收到摄像头画面');
      // clone 防止读取循环把帧 close 掉
      const clone = this.latest.clone();
      try {
        return await createImageBitmap(clone);
      } finally {
        clone.close();
      }
    }
    const v = this.video;
    if (!v) throw new Error('摄像头未启动');
    const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
    c.getContext('2d')!.drawImage(v, 0, 0);
    return createImageBitmap(c);
  }

  async stop() {
    this.running = false;
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    this.reader = null;
    this.latest?.close();
    this.latest = null;
    this.video?.pause();
    this.video = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }
}
