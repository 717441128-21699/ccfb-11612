/**
 * WebGL2 画面合成器：
 *  - 实时取景画面（HTMLVideoElement 逐帧上传）
 *  - 最多 3 层洋葱皮叠加，每层独立色调与不透明度
 *    层 0：前一帧（红）  层 1：前两帧（橙）  层 2：后一帧（绿）
 *  - 回放模式：把某一帧位图作为整幅画面显示，洋葱皮自动关闭
 */

export interface OnionLayer {
  tint: [number, number, number];
  opacity: number; // 0..1，0 表示关闭该层
}

const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uLive;
uniform sampler2D uOnion0;
uniform sampler2D uOnion1;
uniform sampler2D uOnion2;
uniform float uLiveAlpha;
uniform vec3 uTint0;
uniform vec3 uTint1;
uniform vec3 uTint2;
uniform float uOp0;
uniform float uOp1;
uniform float uOp2;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// 把洋葱帧的亮度映射到色调上，暗部略微抬升让轮廓在实景上可见
vec3 ghost(vec3 tint, float l) { return tint * (0.15 + 0.85 * l); }

void main() {
  vec3 col = texture(uLive, vUV).rgb * uLiveAlpha;
  col = mix(col, ghost(uTint2, luma(texture(uOnion2, vUV).rgb)), uOp2);
  col = mix(col, ghost(uTint1, luma(texture(uOnion1, vUV).rgb)), uOp1);
  col = mix(col, ghost(uTint0, luma(texture(uOnion0, vUV).rgb)), uOp0);
  outColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class Compositor {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private textures: WebGLTexture[] = [];
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private video: HTMLVideoElement | null = null;
  private still: ImageBitmap | null = null;
  private layers: OnionLayer[] = [
    { tint: [1, 0.25, 0.25], opacity: 0 },
    { tint: [1, 0.6, 0.2], opacity: 0 },
    { tint: [0.3, 1, 0.4], opacity: 0 },
  ];
  private liveAlpha = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(this.program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(this.program));
    }
    gl.useProgram(this.program);

    // 全屏三角形
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    for (let i = 0; i < 4; i++) this.textures.push(this.createTexture());

    const samplerNames = ['uLive', 'uOnion0', 'uOnion1', 'uOnion2'];
    samplerNames.forEach((n, i) => {
      const loc = gl.getUniformLocation(this.program, n);
      gl.uniform1i(loc, i);
      this.uniforms.set(n, loc);
    });
    for (const n of ['uLiveAlpha', 'uTint0', 'uTint1', 'uTint2', 'uOp0', 'uOp1', 'uOp2']) {
      this.uniforms.set(n, gl.getUniformLocation(this.program, n));
    }
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private upload(unit: number, source: TexImageSource): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /** 设置实时取景来源 */
  setVideo(video: HTMLVideoElement): void {
    this.video = video;
    this.still = null;
  }

  /** 回放模式：显示某一静态帧；传 null 回到实时取景 */
  showStill(bitmap: ImageBitmap | null): void {
    this.still = bitmap;
    if (bitmap) this.upload(0, bitmap);
  }

  get isStill(): boolean {
    return this.still !== null;
  }

  /** 更新某一层洋葱皮（slot 0..2），传 null 清除 */
  setOnion(slot: number, bitmap: ImageBitmap | null): void {
    if (bitmap) {
      this.upload(slot + 1, bitmap);
    } else {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + slot + 1);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[slot + 1]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
    }
  }

  setLayer(slot: number, layer: OnionLayer): void {
    this.layers[slot] = layer;
  }

  setLiveAlpha(a: number): void {
    this.liveAlpha = a;
  }

  render(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    if (!this.still && this.video && this.video.readyState >= 2) {
      this.upload(0, this.video);
    }

    gl.uniform1f(this.uniforms.get('uLiveAlpha')!, this.liveAlpha);
    for (let i = 0; i < 3; i++) {
      const l = this.layers[i];
      // 回放（静帧）模式下强制关闭洋葱皮
      const op = this.still ? 0 : l.opacity;
      gl.uniform3fv(this.uniforms.get('uTint' + i)!, l.tint);
      gl.uniform1f(this.uniforms.get('uOp' + i)!, op);
    }

    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
