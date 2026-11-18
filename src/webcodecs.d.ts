/**
 * 最小 WebCodecs 环境声明。
 * 部分 TS 版本的 lib.dom 尚未包含 VideoEncoder / EncodedVideoChunk，
 * 这里补齐本项目用到的部分；若 lib.dom 已内置，skipLibCheck 会忽略重复声明。
 */

interface VideoEncoderConfig {
  codec: string;
  width: number;
  height: number;
  bitrate?: number;
  framerate?: number;
  latencyMode?: 'realtime' | 'quality';
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  avc?: { format?: 'avc' | 'annexb' };
}

interface VideoEncoderEncodeOptions {
  keyFrame?: boolean;
}

interface EncodedVideoChunkInit {
  type: 'key' | 'delta';
  timestamp: number;
  duration?: number;
  data: BufferSource;
}

declare class EncodedVideoChunk {
  constructor(init: EncodedVideoChunkInit);
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  copyTo(destination: BufferSource): void;
}

interface EncodedVideoChunkMetadata {
  decoderConfig?: {
    codec: string;
    codedWidth?: number;
    codedHeight?: number;
    description?: BufferSource;
  };
}

interface VideoEncoderSupport {
  supported?: boolean;
  config?: VideoEncoderConfig;
}

declare class VideoEncoder {
  constructor(init: {
    output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => void;
    error: (e: DOMException) => void;
  });
  readonly state: 'unconfigured' | 'configured' | 'closed';
  readonly encodeQueueSize: number;
  configure(config: VideoEncoderConfig): void;
  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void;
  flush(): Promise<void>;
  close(): void;
  static isConfigSupported(config: VideoEncoderConfig): Promise<VideoEncoderSupport>;
}
