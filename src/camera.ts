/**
 * 摄像头采集。
 * 预览用 <video> 元素(WebGL 每帧直接上传);拍帧用 WebCodecs 的
 * VideoFrame 构造,保证拿到的是未经页面缩放的原始分辨率画面。
 */

export class Camera {
  private stream: MediaStream | null = null;
  readonly video: HTMLVideoElement;
  width = 0;
  height = 0;

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
  }

  get isOpen(): boolean {
    return this.stream !== null;
  }

  async open(width: number, height: number): Promise<void> {
    this.close();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    // 等元数据就绪拿到真实分辨率
    if (this.video.videoWidth === 0) {
      await new Promise<void>((resolve) => {
        this.video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      });
    }
    this.width = this.video.videoWidth;
    this.height = this.video.videoHeight;
  }

  /**
   * 抓一帧:通过 WebCodecs VideoFrame 取当前画面,再转成 ImageBitmap。
   * 调用方负责 close() 返回的位图。
   */
  async captureFrame(): Promise<ImageBitmap> {
    if (!this.isOpen) throw new Error('摄像头未连接');
    const vf = new VideoFrame(this.video, { timestamp: performance.now() * 1000 });
    try {
      return await createImageBitmap(vf);
    } finally {
      vf.close();
    }
  }

  close(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
  }
}
