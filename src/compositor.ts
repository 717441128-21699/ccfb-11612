/**
 * WebGL2 画面合成器。
 * 每帧合成:底层 = 实时摄像头画面(或回放帧),上层 = 洋葱皮
 * (前 N 帧 / 后 N 帧的半透明着色影像,前后可不同颜色)。
 *
 * 已拍帧的纹理走 LRU 缓存(默认 16 张),避免 300 帧全量上传撑爆显存。
 */

import type { StoredFrame } from './frameStore';

const VERT = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  // 翻转 Y:视频/位图上传后上下颠倒
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec3 u_tint;      // 着色(洋葱皮用);纯白 = 不着色
uniform float u_alpha;    // 整体不透明度
uniform bool u_lumaOnly;  // true: 转为灰度再着色(洋葱皮影子效果)
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_lumaOnly) {
    float y = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    outColor = vec4(u_tint * y, u_alpha);
  } else {
    outColor = vec4(c.rgb * u_tint, u_alpha);
  }
}`;

export interface OnionLayer {
  frame: StoredFrame;
  /** 'prev' 用前一帧颜色,'next' 用后一帧颜色 */
  side: 'prev' | 'next';
  /** 距离当前帧的层深,1 = 相邻 */
  depth: number;
}

export interface RenderParams {
  /** 实时预览源;为 null 时不画实时层 */
  live: HTMLVideoElement | null;
  /** 底层帧(回放 / 选中帧);有值时覆盖实时层 */
  baseFrame: StoredFrame | null;
  onion: OnionLayer[];
  prevColor: [number, number, number];
  nextColor: [number, number, number];
  /** 洋葱皮基础不透明度 0-1,随层深衰减 */
  onionAlpha: number;
}

interface TexEntry {
  tex: WebGLTexture;
  lastUsed: number;
}

const TEX_CACHE_CAP = 16;

export class Compositor {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private uTint: WebGLUniformLocation;
  private uAlpha: WebGLUniformLocation;
  private uLumaOnly: WebGLUniformLocation;
  private liveTex: WebGLTexture;
  private cache = new Map<number, TexEntry>();
  private tick = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;

    this.prog = this.buildProgram();
    this.uTint = gl.getUniformLocation(this.prog, 'u_tint')!;
    this.uAlpha = gl.getUniformLocation(this.prog, 'u_alpha')!;
    this.uLumaOnly = gl.getUniformLocation(this.prog, 'u_lumaOnly')!;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.liveTex = this.createTexture();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private buildProgram(): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    return prog;
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** 画布尺寸对齐内容分辨率(显示大小由 CSS 控制) */
  resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private frameTexture(frame: StoredFrame): WebGLTexture {
    const hit = this.cache.get(frame.id);
    if (hit) {
      hit.lastUsed = ++this.tick;
      return hit.tex;
    }
    const gl = this.gl;
    const tex = this.createTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.bitmap);
    this.cache.set(frame.id, { tex, lastUsed: ++this.tick });
    if (this.cache.size > TEX_CACHE_CAP) {
      // 淘汰最久未用的纹理
      let oldestId = -1;
      let oldestTick = Infinity;
      for (const [id, e] of this.cache) {
        if (e.lastUsed < oldestTick) {
          oldestTick = e.lastUsed;
          oldestId = id;
        }
      }
      const victim = this.cache.get(oldestId);
      if (victim) {
        gl.deleteTexture(victim.tex);
        this.cache.delete(oldestId);
      }
    }
    return tex;
  }

  /** 帧被替换 / 删除后调用,丢弃旧纹理 */
  invalidate(frameId: number): void {
    const e = this.cache.get(frameId);
    if (e) {
      this.gl.deleteTexture(e.tex);
      this.cache.delete(frameId);
    }
  }

  private draw(tex: WebGLTexture, tint: [number, number, number], alpha: number, lumaOnly: boolean): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform3fv(this.uTint, tint);
    gl.uniform1f(this.uAlpha, alpha);
    gl.uniform1i(this.uLumaOnly, lumaOnly ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render(p: RenderParams): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 底层:回放帧优先,否则实时摄像头
    if (p.baseFrame) {
      this.draw(this.frameTexture(p.baseFrame), [1, 1, 1], 1, false);
    } else if (p.live && p.live.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, this.liveTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.live);
      this.draw(this.liveTex, [1, 1, 1], 1, false);
    }

    // 洋葱皮:远层先画,近层后画
    const layers = [...p.onion].sort((a, b) => b.depth - a.depth);
    for (const layer of layers) {
      const color = layer.side === 'prev' ? p.prevColor : p.nextColor;
      const alpha = p.onionAlpha / layer.depth;
      this.draw(this.frameTexture(layer.frame), color, alpha, true);
    }
  }
}
