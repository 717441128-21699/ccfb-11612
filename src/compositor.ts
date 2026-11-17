/**
 * WebGL2 画面合成器:
 *  - 一路基础纹理(实时取景画面或回放帧)
 *  - 最多 4 路洋葱皮纹理,每路可独立设置色调与透明度
 *    (前帧暖色、后帧冷色,对着影子摆位置)
 */

export const MAX_GHOSTS = 4;

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBase;
uniform sampler2D uGhost[${MAX_GHOSTS}];
uniform vec3 uGhostTint[${MAX_GHOSTS}];
uniform float uGhostOpacity[${MAX_GHOSTS}];
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uBase, vUv).rgb;
  for (int i = 0; i < ${MAX_GHOSTS}; i++) {
    float op = uGhostOpacity[i];
    if (op > 0.001) {
      vec3 g = texture(uGhost[i], vUv).rgb;
      float lum = dot(g, vec3(0.299, 0.587, 0.114));
      // 保留部分原色,再按亮度叠色调,影子轮廓清晰可辨
      vec3 tinted = mix(g, uGhostTint[i] * (lum * 1.2 + 0.1), 0.7);
      c = mix(c, tinted, op);
    }
  }
  outColor = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader 编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class Compositor {
  private gl: WebGL2RenderingContext;
  private baseTex: WebGLTexture;
  private ghostTexs: WebGLTexture[] = [];
  private ghostOpacity = new Float32Array(MAX_GHOSTS);
  private ghostTint = new Float32Array(MAX_GHOSTS * 3);

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program 链接失败: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    // 全屏三角形
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // 摄像头/位图均为左上原点,WebGL UV 左下原点,统一翻转
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const mkTex = (unit: number) => {
      const tex = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      return tex;
    };

    this.baseTex = mkTex(0);
    for (let i = 0; i < MAX_GHOSTS; i++) this.ghostTexs.push(mkTex(i + 1));

    gl.uniform1i(gl.getUniformLocation(prog, 'uBase'), 0);
    gl.uniform1iv(gl.getUniformLocation(prog, 'uGhost[0]'), [1, 2, 3, 4]);
  }

  /** 画布尺寸(像素),与视频源分辨率一致 */
  resize(w: number, h: number) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /** 上传基础画面(VideoFrame / ImageBitmap / HTMLVideoElement 均可) */
  setBase(source: TexImageSource) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /** 上传某一路洋葱皮画面 */
  setGhostImage(slot: number, source: TexImageSource) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1 + slot);
    gl.bindTexture(gl.TEXTURE_2D, this.ghostTexs[slot]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /** 设置某一路洋葱皮的色调与透明度(opacity=0 即关闭) */
  setGhostStyle(slot: number, r: number, g: number, b: number, opacity: number) {
    this.ghostTint[slot * 3] = r;
    this.ghostTint[slot * 3 + 1] = g;
    this.ghostTint[slot * 3 + 2] = b;
    this.ghostOpacity[slot] = opacity;
  }

  clearGhosts() {
    this.ghostOpacity.fill(0);
  }

  render() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const prog = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    gl.uniform3fv(gl.getUniformLocation(prog, 'uGhostTint[0]'), this.ghostTint);
    gl.uniform1fv(gl.getUniformLocation(prog, 'uGhostOpacity[0]'), this.ghostOpacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
