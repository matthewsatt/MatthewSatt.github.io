// Live Video Lab
//
// A complete WebRTC media pipeline that runs inside one browser tab:
//
//   source (procedural canvas | camera) ─► WebGL shader ─► canvas.captureStream()
//     ─► RTCPeerConnection pc1 ══ SRTP over ICE ══► RTCPeerConnection pc2 ─► <video>
//
// There is no signaling server and no STUN/TURN. The two peers trade SDP and ICE
// candidates in memory, so media never leaves the device. Everything shown in the
// console panel is read back from getStats().

const W = 960;
const H = 540;
const FPS = 30;
const HISTORY = 60;
const STATS_INTERVAL = 1000;
const CONNECT_TIMEOUT = 10000;

const CODECS = { vp8: 'video/vp8', vp9: 'video/vp9', h264: 'video/h264', av1: 'video/av1' };
const CODEC_LABEL = { 'video/vp8': 'VP8', 'video/vp9': 'VP9', 'video/h264': 'H.264', 'video/av1': 'AV1' };
const EFFECTS = ['raw', 'thermal', 'edges', 'dither'];
const LIMIT_LABEL = { none: 'Nothing', bandwidth: 'Bandwidth cap', cpu: 'CPU', other: 'Other' };

// Bitrate slider is logarithmic: 50 kbps … 6 Mbps.
const BR_MIN = 50_000;
const BR_MAX = 6_000_000;
const sliderToBps = (v) => Math.round((BR_MIN * (BR_MAX / BR_MIN) ** (v / 1000)) / 10_000) * 10_000;
const bpsToSlider = (b) => Math.round((1000 * Math.log(b / BR_MIN)) / Math.log(BR_MAX / BR_MIN));

function formatBps(bps) {
  if (bps >= 1e6) return { value: (bps / 1e6).toFixed(2), unit: 'Mbps' };
  return { value: String(Math.round(bps / 1e3)), unit: 'kbps' };
}
function formatCap(bps) {
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

function timecode(frame) {
  const pad = (n) => String(n).padStart(2, '0');
  const s = Math.floor(frame / FPS);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(frame % FPS)}`;
}

async function fontsReady() {
  if (!document.fonts?.load) return;
  const load = Promise.all([
    document.fonts.load('600 72px "Geist"'),
    document.fonts.load('500 30px "Geist Mono"'),
  ]).catch(() => {});
  await Promise.race([load, new Promise((resolve) => setTimeout(resolve, 1500))]);
}

/* ==========================================================================
   Procedural test signal — a broadcast-style test card, drawn per frame.
   Static elements are pre-rendered once; only moving parts are drawn live.
   ========================================================================== */

const MONO = '"Geist Mono", ui-monospace, Menlo, monospace';
const SANS = '"Geist", ui-sans-serif, system-ui, sans-serif';
const LIME = '#c6ff3d';
const lime = (a) => `rgba(198, 255, 61, ${a})`;

class TestSignal {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.base = Object.assign(document.createElement('canvas'), { width: w, height: h });

    this.cx = w / 2;
    this.cy = 266;
    this.R = 170;

    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    this.targets = Array.from({ length: 9 }, () => ({ a: rnd() * Math.PI * 2, r: 0.22 + rnd() * 0.72 }));

    this.buildBase();
  }

  buildBase() {
    const { w, h, cx, cy, R } = this;
    const g = this.base.getContext('2d', { alpha: false });

    g.fillStyle = '#0a0a0c';
    g.fillRect(0, 0, w, h);

    // Grid
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0.5; x < w; x += 48) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = 0.5; y < h; y += 48) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();

    // 75% colour bars across the top, luma wedge along the bottom
    const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    bars.forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect(Math.round((i * w) / bars.length), 0, Math.ceil(w / bars.length), 20);
    });
    for (let i = 0; i < 12; i++) {
      const v = Math.round((i / 11) * 235 + 10);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(Math.round((i * w) / 12), h - 12, Math.ceil(w / 12), 12);
    }

    // Labels
    g.textBaseline = 'alphabetic';
    g.font = `500 11px ${MONO}`;
    g.fillStyle = 'rgba(255,255,255,0.5)';
    if ('letterSpacing' in g) g.letterSpacing = '2px';
    g.textAlign = 'left';
    g.fillText('RES WEDGE', 40, 54);
    g.fillText('MOTION', 744, 54);
    g.textAlign = 'center';
    g.fillText('MATTHEW SATTERWHITE · TEST SIGNAL', cx, 54);
    g.textAlign = 'right';
    g.fillText(`${w}×${h} · ${FPS}P · SDR`, w - 40, h - 52);
    if ('letterSpacing' in g) g.letterSpacing = '0px';

    // Resolution wedge: gratings of 8, 4, 2 and 1 px lines — the first thing to
    // smear when the bitrate cap starves the encoder.
    const px = 40, py = 64, pw = 176, ph = 372;
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    const periods = [16, 8, 4, 2];
    const bandH = (ph - 16 - 8 * 3) / 4;
    periods.forEach((p, k) => {
      const by = py + 8 + k * (bandH + 8);
      g.fillStyle = '#f0f0ea';
      for (let x = px + 8; x < px + pw - 8; x += p) g.fillRect(x, by, p / 2, bandH);
    });

    // Motion panel frame + clock face
    const mx = 744;
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.strokeRect(mx + 0.5, py + 0.5, pw - 1, ph - 1);
    g.beginPath();
    g.moveTo(mx + 12, 336.5); g.lineTo(mx + pw - 12, 336.5);
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    g.stroke();
    const ccx = mx + pw / 2, ccy = 386;
    for (let i = 0; i < FPS; i++) {
      const a = (i / FPS) * Math.PI * 2 - Math.PI / 2;
      const r1 = i % 5 === 0 ? 28 : 32;
      g.beginPath();
      g.moveTo(ccx + Math.cos(a) * r1, ccy + Math.sin(a) * r1);
      g.lineTo(ccx + Math.cos(a) * 36, ccy + Math.sin(a) * 36);
      g.strokeStyle = i % 5 === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.18)';
      g.lineWidth = i % 5 === 0 ? 1.5 : 1;
      g.stroke();
    }
    g.lineWidth = 1;

    // Radar rings, crosshair and bezel ticks
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    [0.25, 0.5, 0.75, 1].forEach((f) => { g.beginPath(); g.arc(cx, cy, R * f, 0, Math.PI * 2); g.stroke(); });
    g.beginPath();
    g.moveTo(cx - R - 14, cy + 0.5); g.lineTo(cx + R + 14, cy + 0.5);
    g.moveTo(cx + 0.5, cy - R - 14); g.lineTo(cx + 0.5, cy + R + 14);
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.stroke();
    for (let deg = 0; deg < 360; deg += 10) {
      const a = (deg * Math.PI) / 180;
      const len = deg % 30 === 0 ? 10 : 5;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len));
      g.strokeStyle = deg % 30 === 0 ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.2)';
      g.stroke();
    }

    // Frame-cadence strobe (one cell per frame of the second)
    const cell = 10, gap = 4, total = FPS * (cell + gap) - gap;
    const sx = Math.round(cx - total / 2);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < FPS; i++) g.fillRect(sx + i * (cell + gap), 488, cell, cell);
    this.strobe = { x: sx, y: 488, cell, gap };
  }

  draw(t, tc, frame) {
    const { ctx, w, cx, cy, R } = this;
    ctx.drawImage(this.base, 0, 0);

    // Radar sweep with a fading trail
    const a = t * 1.25;
    const steps = 36, span = 0.95;
    for (let i = 0; i < steps; i++) {
      const a1 = a - (i / steps) * span;
      const a0 = a - ((i + 1) / steps) * span;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = lime(0.2 * (1 - i / steps) ** 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.strokeStyle = LIME;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;

    // Targets light up as the sweep passes, then decay
    const TAU = Math.PI * 2;
    for (const tg of this.targets) {
      const d = (((a - tg.a) % TAU) + TAU) % TAU;
      const k = d < 2.6 ? (1 - d / 2.6) ** 1.6 : 0;
      if (k <= 0.01) continue;
      const x = cx + Math.cos(tg.a) * tg.r * R;
      const y = cy + Math.sin(tg.a) * tg.r * R;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, TAU);
      ctx.fillStyle = lime(k);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 4 + (1 - k) * 14, 0, TAU);
      ctx.strokeStyle = lime(k * 0.5);
      ctx.stroke();
    }

    // Center ident
    ctx.beginPath();
    ctx.arc(cx, cy, 54, 0, TAU);
    ctx.fillStyle = '#0a0a0c';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.stroke();
    ctx.fillStyle = '#f3f3ef';
    ctx.font = `600 50px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MS', cx, cy + 2);

    // Motion: a bouncing ball with a short ghost trail
    const tri = (x) => 1 - Math.abs((x % 2) - 1);
    const bx0 = 756, by0 = 76, bw = 152, bh = 248, br = 13;
    for (let k = 5; k >= 0; k--) {
      const tt = t - k * 0.035;
      const x = bx0 + br + tri(tt * 0.43) * (bw - br * 2);
      const y = by0 + br + tri(tt * 0.61) * (bh - br * 2);
      ctx.beginPath();
      ctx.arc(x, y, br, 0, TAU);
      ctx.fillStyle = k === 0 ? LIME : lime(0.12 * (1 - k / 6));
      ctx.fill();
    }

    // Clock hand: one revolution per second, one tick per frame
    const ccx = 832, ccy = 386;
    const ha = ((frame % FPS) / FPS) * TAU - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(ccx, ccy);
    ctx.lineTo(ccx + Math.cos(ha) * 30, ccy + Math.sin(ha) * 30);
    ctx.strokeStyle = LIME;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(ccx, ccy, 3, 0, TAU);
    ctx.fillStyle = LIME;
    ctx.fill();

    // Strobe: light the current frame's cell
    const { x: sx, y: sy, cell, gap } = this.strobe;
    ctx.fillStyle = LIME;
    ctx.fillRect(sx + (frame % FPS) * (cell + gap), sy, cell, cell);

    // Timecode + frame counter
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = `500 30px ${MONO}`;
    ctx.fillStyle = '#f3f3ef';
    ctx.fillText(tc, 40, 508);
    ctx.font = `500 11px ${MONO}`;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'right';
    ctx.fillText(`FRAME ${String(frame).padStart(6, '0')}`, w - 40, 54);

    // Slow scanline
    ctx.fillStyle = lime(0.07);
    ctx.fillRect(0, (frame * 3) % this.h, w, 2);
  }
}

/* ==========================================================================
   Renderers — WebGL with GLSL effects, or a plain 2D fallback.
   ========================================================================== */

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec4 uCrop;     // xy: scale, zw: offset — cover-fit crop in source UV space
uniform vec2 uTexel;    // 1 / source size
uniform float uMirror;
uniform int uMode;      // 0 raw, 1 thermal, 2 edges, 3 dither

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 src(vec2 uv) { return texture2D(uTex, uv).rgb; }

vec3 thermal(float t) {
  vec3 c = mix(vec3(0.02, 0.0, 0.08), vec3(0.32, 0.0, 0.62), smoothstep(0.0, 0.25, t));
  c = mix(c, vec3(0.88, 0.08, 0.38), smoothstep(0.2, 0.5, t));
  c = mix(c, vec3(1.0, 0.56, 0.0), smoothstep(0.45, 0.75, t));
  return mix(c, vec3(1.0, 0.98, 0.72), smoothstep(0.72, 1.0, t));
}

// Ordered (Bayer) dithering without lookup tables.
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

void main() {
  const vec3 ink = vec3(0.776, 1.0, 0.239);
  const vec3 base = vec3(0.035, 0.035, 0.04);

  vec2 p = vec2(mix(vUv.x, 1.0 - vUv.x, uMirror), vUv.y);
  vec2 uv = p * uCrop.xy + uCrop.zw;
  vec3 col = src(uv);

  if (uMode == 1) {
    col = thermal(luma(col));
  } else if (uMode == 2) {
    vec2 d = uTexel * 1.5;
    float tl = luma(src(uv + vec2(-d.x,  d.y)));
    float tc = luma(src(uv + vec2( 0.0,  d.y)));
    float tr = luma(src(uv + vec2( d.x,  d.y)));
    float ml = luma(src(uv + vec2(-d.x,  0.0)));
    float mr = luma(src(uv + vec2( d.x,  0.0)));
    float bl = luma(src(uv + vec2(-d.x, -d.y)));
    float bc = luma(src(uv + vec2( 0.0, -d.y)));
    float br = luma(src(uv + vec2( d.x, -d.y)));
    float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
    float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
    float e = smoothstep(0.12, 0.5, length(vec2(gx, gy)));
    col = mix(base, ink, e) + luma(col) * 0.05;
  } else if (uMode == 3) {
    float l = smoothstep(0.07, 0.92, luma(col));
    col = mix(base, ink, step(bayer8(gl_FragCoord.xy / 2.0), l));
  }
  gl_FragColor = vec4(col, 1.0);
}`;

function createGLRenderer(canvas) {
  const gl = canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: true, powerPreference: 'low-power',
  });
  if (!gl) return null;

  let program, uniforms, tex, texW = 0, texH = 0, lost = false;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
    return shader;
  };

  const setup = () => {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'link failed');
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    texW = texH = 0;

    uniforms = Object.fromEntries(['uCrop', 'uTexel', 'uMirror', 'uMode', 'uTex']
      .map((name) => [name, gl.getUniformLocation(program, name)]));
    gl.uniform1i(uniforms.uTex, 0);
  };

  try { setup(); } catch (err) { console.warn('[live-lab] WebGL setup failed', err); return null; }

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => {
    try { setup(); lost = false; } catch (err) { console.warn('[live-lab] WebGL restore failed', err); }
  });

  return {
    kind: 'webgl',
    draw(source, sw, sh, mode, mirror) {
      if (lost) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (sw !== texW || sh !== texH) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        texW = sw; texH = sh;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      }
      const sa = sw / sh;
      const da = canvas.width / canvas.height;
      const sx = sa > da ? da / sa : 1;
      const sy = sa > da ? 1 : sa / da;
      gl.uniform4f(uniforms.uCrop, sx, sy, (1 - sx) / 2, (1 - sy) / 2);
      gl.uniform2f(uniforms.uTexel, 1 / sw, 1 / sh);
      gl.uniform1f(uniforms.uMirror, mirror ? 1 : 0);
      gl.uniform1i(uniforms.uMode, mode);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

function create2DRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  return {
    kind: '2d',
    draw(source, sw, sh, _mode, mirror) {
      const da = canvas.width / canvas.height;
      const sa = sw / sh;
      const cw = sa > da ? sh * da : sw;
      const ch = sa > da ? sh : sw / da;
      ctx.save();
      if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(source, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    },
  };
}

/* ==========================================================================
   The lab
   ========================================================================== */

class LiveLab {
  constructor(root) {
    this.root = root;
    const q = (s) => root.querySelector(s);
    const all = (s) => [...root.querySelectorAll(s)];
    this.ui = {
      screen: q('.screen'),
      video: q('[data-rx]'),
      canvas: q('[data-tx]'),
      tally: q('[data-tally]'),
      conn: q('[data-conn]'),
      timecode: q('[data-timecode]'),
      pause: q('[data-pause]'),
      start: q('[data-start]'),
      overlayTitle: q('[data-overlay-title]'),
      overlayText: q('[data-overlay-text]'),
      log: q('[data-log]'),
      bitrate: q('[data-bitrate]'),
      bitrateOut: q('[data-bitrate-out]'),
      capLabel: q('[data-cap-label]'),
      spark: q('[data-spark]'),
      sparkLine: q('[data-spark-line]'),
      sparkArea: q('[data-spark-area]'),
      sparkCap: q('[data-spark-cap]'),
      stat: Object.fromEntries(all('[data-stat]').map((el) => [el.dataset.stat, el])),
      node: Object.fromEntries(all('[data-node]').map((el) => [el.dataset.node, el.querySelector('span')])),
      controls: Object.fromEntries(all('[data-control]').map((el) => [el.dataset.control, el])),
    };

    this.state = 'idle';
    this.source = 'signal';
    this.effect = 'raw';
    this.codec = null;        // user's preference; null = browser default
    this.activeCodec = null;  // what getStats says is actually in use
    this.maxBitrate = 2_500_000;
    this.paused = false;
    this.inView = false;
    this.pageVisible = document.visibilityState === 'visible';
    this.frame = 0;
    this.lastTick = 0;
    this.history = [];
    this.prevOut = null;
    this.prevLimit = null;
    this.raf = 0;
    this.statsTimer = 0;

    this.signal = new TestSignal(W, H);
    this.renderer = createGLRenderer(this.ui.canvas) ?? create2DRenderer(this.ui.canvas);
    this.codecSupport = LiveLab.codecSupport();
    this.loop = this.loop.bind(this);

    fontsReady().then(() => { this.signal.buildBase(); if (!this.raf) this.renderFrame(); });

    this.bindControls();
    this.syncControls();
    this.renderFrame();
    this.setState('idle');
    this.log(`Renderer · ${this.renderer.kind === 'webgl' ? 'WebGL' : 'Canvas 2D'} ready`);
    this.observe();
  }

  static missingFeatures() {
    const missing = [];
    if (typeof RTCPeerConnection === 'undefined') missing.push('RTCPeerConnection');
    if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') missing.push('canvas.captureStream');
    return missing;
  }

  static codecSupport() {
    const send = window.RTCRtpSender?.getCapabilities?.('video')?.codecs ?? [];
    const recv = window.RTCRtpReceiver?.getCapabilities?.('video')?.codecs ?? [];
    const canPrefer = typeof RTCRtpTransceiver !== 'undefined' && 'setCodecPreferences' in RTCRtpTransceiver.prototype;
    const has = (list, mime) => list.some((c) => c.mimeType.toLowerCase() === mime);
    return Object.fromEntries(Object.entries(CODECS).map(([id, mime]) => [id, canPrefer && has(send, mime) && has(recv, mime)]));
  }

  /* ---------- lifecycle ---------- */

  observe() {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let autostarted = reduce;

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => {
        this.inView = entry.isIntersecting;
        if (this.inView && !autostarted) { autostarted = true; this.start(); }
        this.updateRunning();
      }, { threshold: 0.05 }).observe(this.root);
    } else {
      this.inView = true;
      if (!autostarted) this.start();
    }

    document.addEventListener('visibilitychange', () => {
      this.pageVisible = document.visibilityState === 'visible';
      this.updateRunning();
    });
    addEventListener('pagehide', () => { this.closePeers(); this.stopCamera(); });
    addEventListener('lab:camera', () => this.setSource('camera'));
  }

  async start() {
    if (this.state === 'connecting' || this.state === 'live') return;
    this.root.classList.remove('is-local');
    this.setState('connecting');
    this.log('Starting pipeline');
    await fontsReady();

    const missing = LiveLab.missingFeatures();
    if (missing.length) { this.goLocal(`${missing.join(' and ')} unavailable`); return; }

    try {
      if (!this.stream) {
        this.stream = this.ui.canvas.captureStream(FPS);
        this.track = this.stream.getVideoTracks()[0];
      }
      this.updateRunning();
      await this.connect();
    } catch (err) {
      this.fail(err);
    }
  }

  async connect() {
    const pc1 = new RTCPeerConnection({ iceServers: [] });
    const pc2 = new RTCPeerConnection({ iceServers: [] });
    this.pc1 = pc1;
    this.pc2 = pc2;

    // Candidates can arrive before the far side has a remote description,
    // so queue them and flush once it does.
    const relay = (from, to) => {
      const queue = [];
      from.addEventListener('icecandidate', ({ candidate }) => {
        if (!candidate) return;
        if (to.remoteDescription) to.addIceCandidate(candidate).catch(() => {});
        else queue.push(candidate);
      });
      return () => queue.splice(0).forEach((c) => to.addIceCandidate(c).catch(() => {}));
    };
    this.flushTo2 = relay(pc1, pc2);
    this.flushTo1 = relay(pc2, pc1);

    pc2.addEventListener('track', (e) => {
      const video = this.ui.video;
      video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      video.play().catch(() => {});
    });
    const onState = () => this.onConnectionState();
    pc1.addEventListener('connectionstatechange', onState);
    pc1.addEventListener('iceconnectionstatechange', onState);

    this.transceiver = pc1.addTransceiver(this.track, { direction: 'sendonly', streams: [this.stream] });
    this.sender = this.transceiver.sender;

    this.connectTimer = setTimeout(() => {
      if (this.state === 'connecting') this.goLocal('ICE could not connect on this network');
    }, CONNECT_TIMEOUT);

    await this.negotiate();
    this.log('SDP offer/answer exchanged');
  }

  async negotiate() {
    const { pc1, pc2 } = this;
    this.preferCodec(this.transceiver);
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    this.flushTo2();
    const rx = pc2.getTransceivers()[0];
    if (rx) this.preferCodec(rx);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    this.flushTo1();
    await this.applyBitrate();
  }

  preferCodec(transceiver) {
    if (!this.codec || typeof transceiver?.setCodecPreferences !== 'function') return;
    const mime = CODECS[this.codec];
    const caps = RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? [];
    const preferred = caps.filter((c) => c.mimeType.toLowerCase() === mime);
    if (!preferred.length) return;
    const rest = caps.filter((c) => c.mimeType.toLowerCase() !== mime);
    try {
      transceiver.setCodecPreferences([...preferred, ...rest]);
    } catch (err) {
      this.log(`setCodecPreferences rejected (${err.name})`);
    }
  }

  async applyBitrate() {
    const sender = this.sender;
    if (!sender?.getParameters) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = this.maxBitrate;
    try {
      await sender.setParameters(params);
    } catch (err) {
      this.log(`setParameters rejected (${err.name})`);
    }
  }

  onConnectionState() {
    const pc = this.pc1;
    if (!pc) return;
    const state = pc.connectionState || pc.iceConnectionState;
    this.ui.conn.textContent = state;
    if ((state === 'connected' || state === 'completed') && this.state === 'connecting') {
      clearTimeout(this.connectTimer);
      this.setState('live');
      this.log('ICE connected · media flowing');
    } else if (state === 'failed') {
      this.goLocal('ICE failed');
    } else if (state === 'disconnected' && this.state === 'live') {
      this.log('ICE disconnected');
    }
  }

  goLocal(reason) {
    clearTimeout(this.connectTimer);
    this.closePeers();
    this.root.classList.add('is-local');
    this.setState('local');
    this.ui.conn.textContent = 'local only';
    this.log(`${reason}. Showing the local render.`);
    this.syncControls();
  }

  fail(err) {
    console.warn('[live-lab]', err);
    clearTimeout(this.connectTimer);
    this.closePeers();
    this.setState('error');
    this.ui.overlayTitle.textContent = 'Couldn’t go live.';
    this.ui.overlayText.textContent = `${err?.name || 'Error'}: ${err?.message || 'the peer connection failed to start.'}`;
    this.ui.start.lastChild.textContent = ' Try again';
    this.log(`Failed: ${err?.name || 'Error'}`);
  }

  closePeers() {
    this.pc1?.close();
    this.pc2?.close();
    this.pc1 = this.pc2 = this.sender = this.transceiver = null;
    this.ui.video.srcObject = null;
    this.root.classList.remove('has-frame');
    this.prevOut = null;
    this.prevLimit = null;
    this.updateRunning();
  }

  stopCamera() {
    this.cam?.getTracks().forEach((t) => t.stop());
    this.cam = null;
    this.camVideo?.remove();
    this.camVideo = null;
  }

  setState(state) {
    this.state = state;
    this.root.dataset.state = state;
    const labels = { idle: 'STANDBY', connecting: 'CONNECTING', live: 'LIVE', local: 'LOCAL', error: 'OFFLINE' };
    this.ui.tally.textContent = this.paused && (state === 'live' || state === 'local') ? 'PAUSED' : labels[state];
    if (state === 'idle') this.ui.conn.textContent = 'idle';
    if (state === 'connecting') {
      this.ui.conn.textContent = 'new';
      this.ui.overlayTitle.textContent = 'Negotiating';
      this.ui.overlayText.textContent = 'Exchanging SDP and ICE candidates between the two peers.';
    }
    const halted = state === 'idle' || state === 'error';
    this.ui.pause.setAttribute('aria-pressed', String(halted || this.paused));
    this.ui.pause.setAttribute('aria-label', halted || this.paused ? 'Start live demo' : 'Pause live demo');
    this.updateRunning();
  }

  togglePause() {
    if (this.state === 'idle' || this.state === 'error') { this.start(); return; }
    this.paused = !this.paused;
    this.root.classList.toggle('is-paused', this.paused);
    this.log(this.paused ? 'Paused · no new frames to encode' : 'Resumed');
    this.setState(this.state);
  }

  updateRunning() {
    const active = this.state === 'live' || this.state === 'connecting' || this.state === 'local';
    const render = active && !this.paused && this.inView && this.pageVisible;
    if (render && !this.raf) { this.lastTick = 0; this.raf = requestAnimationFrame(this.loop); }
    if (!render && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }

    const stats = this.state === 'live' && !!this.pc1 && this.inView && this.pageVisible;
    if (stats && !this.statsTimer) {
      this.prevOut = null;
      this.statsTimer = setInterval(() => this.pollStats(), STATS_INTERVAL);
    }
    if (!stats && this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = 0; }
  }

  /* ---------- rendering ---------- */

  loop(now) {
    this.raf = requestAnimationFrame(this.loop);
    const interval = 1000 / FPS;
    if (this.lastTick && now - this.lastTick < interval - 1.5) return;
    // Hold a steady cadence on high-refresh displays; resync after stalls.
    this.lastTick = this.lastTick && now - this.lastTick < interval * 2 ? this.lastTick + interval : now;
    this.renderFrame();
  }

  renderFrame() {
    this.frame++;
    const tc = timecode(this.frame);
    const cam = this.camVideo;
    let source = this.signal.canvas, sw = W, sh = H, mirror = false;
    if (this.source === 'camera' && cam && cam.readyState >= 2 && cam.videoWidth) {
      source = cam; sw = cam.videoWidth; sh = cam.videoHeight; mirror = true;
    } else {
      this.signal.draw(this.frame / FPS, tc, this.frame);
    }
    this.renderer.draw(source, sw, sh, EFFECTS.indexOf(this.effect), mirror);
    this.ui.timecode.textContent = tc;
  }

  /* ---------- controls ---------- */

  bindControls() {
    const { controls, video, bitrate } = this.ui;
    this.ui.start.addEventListener('click', () => this.start());
    this.ui.pause.addEventListener('click', () => this.togglePause());

    controls.source.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn) this.setSource(btn.dataset.value);
    });
    controls.effect.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn && !btn.disabled) this.setEffect(btn.dataset.value);
    });
    controls.codec.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn && !btn.disabled) this.setCodec(btn.dataset.value);
    });

    bitrate.value = String(bpsToSlider(this.maxBitrate));
    this.syncBitrateLabel();
    let pending = 0;
    bitrate.addEventListener('input', () => {
      this.maxBitrate = sliderToBps(Number(bitrate.value));
      this.syncBitrateLabel();
      clearTimeout(pending);
      pending = setTimeout(() => this.applyBitrate(), 120);
    });
    bitrate.addEventListener('change', () => this.log(`maxBitrate → ${formatCap(this.maxBitrate)} via setParameters()`));

    video.addEventListener('loadeddata', () => this.root.classList.add('has-frame'));
    let lastSize = '';
    video.addEventListener('resize', () => {
      const size = `${video.videoWidth}×${video.videoHeight}`;
      if (lastSize && size !== lastSize) this.log(`Decoder output → ${size}`);
      lastSize = size;
    });
  }

  syncBitrateLabel() {
    const { bitrate, bitrateOut, capLabel } = this.ui;
    const label = formatCap(this.maxBitrate);
    bitrateOut.textContent = label;
    capLabel.textContent = label;
    bitrate.style.setProperty('--fill', `${(Number(bitrate.value) / 1000) * 100}%`);
    bitrate.setAttribute('aria-valuetext', label);
  }

  async setSource(kind) {
    if (kind === 'signal') {
      if (this.source === 'signal') return;
      this.stopCamera();
      this.source = 'signal';
      this.log('Source → procedural test signal');
      this.syncControls();
      return;
    }

    if (this.source === 'camera' && this.camVideo) return;
    if (!navigator.mediaDevices?.getUserMedia) { this.log('Camera API unavailable in this context'); return; }
    const btn = this.ui.controls.source.querySelector('[data-value="camera"]');
    btn.classList.add('is-busy');
    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: FPS } },
        audio: false,
      });
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      v.style.cssText = 'position:absolute;width:2px;height:2px;opacity:0;pointer-events:none;';
      v.srcObject = cam;
      this.ui.screen.append(v);
      await v.play();

      this.stopCamera();
      this.cam = cam;
      this.camVideo = v;
      this.source = 'camera';
      const track = cam.getVideoTracks()[0];
      track.addEventListener('ended', () => this.setSource('signal'));
      const { width, height } = track.getSettings();
      this.log(`Camera on · ${width ?? v.videoWidth}×${height ?? v.videoHeight} · stays on this device`);
      if (this.state === 'idle' || this.state === 'error') this.start();
    } catch (err) {
      this.log(err?.name === 'NotAllowedError'
        ? 'Camera permission declined. Staying on the test signal.'
        : `Camera unavailable (${err?.name || 'error'})`);
    } finally {
      btn.classList.remove('is-busy');
      this.syncControls();
    }
  }

  setEffect(effect) {
    if (effect === this.effect) return;
    this.effect = effect;
    this.log(`Shader → ${effect}`);
    this.syncControls();
    if (!this.raf) this.renderFrame();
  }

  async setCodec(id) {
    if (!this.codecSupport[id]) return;
    this.codec = id;
    this.syncControls();
    if (this.state !== 'live' || !this.pc1) return;
    this.log(`Renegotiating SDP → prefer ${CODEC_LABEL[CODECS[id]]}`);
    try {
      await this.negotiate();
    } catch (err) {
      this.log(`Renegotiation failed (${err.name})`);
    }
  }

  syncControls() {
    const { controls, node } = this.ui;
    const press = (group, value) => controls[group].querySelectorAll('button[data-value]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));

    press('source', this.source);
    press('effect', this.effect);

    const activeId = Object.keys(CODECS).find((id) => CODECS[id] === this.activeCodec);
    press('codec', this.codec ?? activeId);

    const local = this.state === 'local';
    controls.codec.querySelectorAll('button[data-value]').forEach((b) => {
      const ok = this.codecSupport[b.dataset.value];
      b.disabled = local || !ok;
      b.title = ok ? '' : 'Not supported for sending in this browser';
    });
    this.ui.bitrate.disabled = local;

    const gl = this.renderer.kind === 'webgl';
    controls.effect.querySelectorAll('button[data-value]').forEach((b) => {
      b.disabled = !gl && b.dataset.value !== 'raw';
    });

    const cam = this.camVideo;
    node.source.textContent = this.source === 'camera' && cam
      ? `Camera ${cam.videoWidth}×${cam.videoHeight}`
      : `Canvas ${W}×${H}`;
    node.shader.textContent = gl ? `GLSL · ${this.effect}` : 'Canvas 2D';
  }

  /* ---------- telemetry ---------- */

  async pollStats() {
    const { pc1, pc2 } = this;
    if (!pc1 || !pc2) return;
    let s1, s2;
    try { [s1, s2] = await Promise.all([pc1.getStats(), pc2.getStats()]); } catch { return; }

    const isVideo = (r) => (r.kind ?? r.mediaType) === 'video';
    let out, remote, inbound, transport;
    s1.forEach((r) => {
      if (r.type === 'outbound-rtp' && isVideo(r)) out = r;
      else if (r.type === 'remote-inbound-rtp' && isVideo(r)) remote = r;
      else if (r.type === 'transport') transport = r;
    });
    s2.forEach((r) => { if (r.type === 'inbound-rtp' && isVideo(r)) inbound = r; });

    // Bitrate from the byte counter delta
    let bps = null;
    if (out?.bytesSent != null) {
      if (this.prevOut) {
        const dt = (out.timestamp - this.prevOut.timestamp) / 1000;
        if (dt > 0) bps = Math.max(0, ((out.bytesSent - this.prevOut.bytesSent) * 8) / dt);
      }
      this.prevOut = { timestamp: out.timestamp, bytesSent: out.bytesSent };
    }
    if (bps != null) {
      this.history.push(bps);
      if (this.history.length > HISTORY) this.history.shift();
    }

    // Codec actually negotiated
    const codec = (inbound && s2.get(inbound.codecId)) || (out && s1.get(out.codecId));
    const mime = codec?.mimeType?.toLowerCase();
    if (mime && mime !== this.activeCodec) {
      if (this.activeCodec) this.log(`Codec in use → ${CODEC_LABEL[mime] ?? mime}`);
      this.activeCodec = mime;
      this.syncControls();
    }
    const codecName = CODEC_LABEL[mime] ?? (mime ? mime.split('/')[1].toUpperCase() : '—');

    // Transport path
    let pair = transport?.selectedCandidatePairId ? s1.get(transport.selectedCandidatePairId) : null;
    if (!pair) s1.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r; });
    const local = pair ? s1.get(pair.localCandidateId) : null;
    const rtt = remote?.roundTripTime ?? pair?.currentRoundTripTime;

    const fw = inbound?.frameWidth ?? out?.frameWidth;
    const fh = inbound?.frameHeight ?? out?.frameHeight;
    const fps = inbound?.framesPerSecond ?? out?.framesPerSecond;
    const lost = inbound?.packetsLost;
    const received = inbound?.packetsReceived;
    const limit = out?.qualityLimitationReason;

    const { stat, node } = this.ui;
    if (bps != null) {
      const f = formatBps(bps);
      stat.bitrate.textContent = f.value;
      stat['bitrate-unit'].textContent = f.unit;
    }
    stat.codec.textContent = codecName;
    stat.resolution.textContent = fw && fh ? `${fw}×${fh}` : '—';
    stat.fps.textContent = fps != null ? `${Math.round(fps)} fps` : '—';
    stat.rtt.textContent = rtt != null ? `${(rtt * 1000).toFixed(rtt < 0.01 ? 2 : 1)} ms` : '—';
    stat.jitter.textContent = inbound?.jitter != null ? `${(inbound.jitter * 1000).toFixed(1)} ms` : '—';
    stat.lost.textContent = lost != null
      ? `${lost.toLocaleString()} · ${received ? ((lost / (lost + received)) * 100).toFixed(2) : '0.00'}%`
      : '—';
    stat.limit.textContent = limit ? LIMIT_LABEL[limit] ?? limit : '—';
    stat.limit.classList.toggle('is-limited', !!limit && limit !== 'none');
    if (limit && this.prevLimit && limit !== this.prevLimit) {
      this.log(limit === 'none' ? 'Encoder no longer limited' : `Encoder limited by ${LIMIT_LABEL[limit] ?? limit}`);
    }
    if (limit) this.prevLimit = limit;

    const impl = (s) => (s && s !== 'unknown' ? ` · ${s}` : '');
    node.encoder.textContent = `${codecName}${impl(out?.encoderImplementation)}`;
    node.decoder.textContent = `${codecName}${impl(inbound?.decoderImplementation)}`;
    node.transport.textContent = local
      ? `${(local.protocol || 'udp').toUpperCase()} ${local.candidateType || 'host'} · SRTP`
      : 'SRTP · ICE';
    node.output.textContent = fw ? `${fw}×${fh} · ${Math.round(fps ?? 0)} fps` : '<video>';

    this.drawSpark();
  }

  drawSpark() {
    const data = this.history;
    if (!data.length) return;
    const w = 300, h = 72, pad = 4;
    const peak = Math.max(...data);
    const yMax = Math.max(peak * 1.25, 150_000);
    const x = (i) => ((HISTORY - data.length + i) / (HISTORY - 1)) * w;
    const y = (v) => h - pad - (v / yMax) * (h - pad * 2);

    let d = '';
    data.forEach((v, i) => { d += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; });
    this.ui.sparkLine.setAttribute('d', d);
    this.ui.sparkArea.setAttribute('d', data.length > 1 ? `${d}L${x(data.length - 1).toFixed(1)} ${h}L${x(0).toFixed(1)} ${h}Z` : '');

    const capY = this.maxBitrate <= yMax ? y(this.maxBitrate).toFixed(1) : -10;
    this.ui.sparkCap.setAttribute('y1', capY);
    this.ui.sparkCap.setAttribute('y2', capY);

    const now = formatBps(data[data.length - 1]);
    const top = formatBps(peak);
    this.ui.spark.setAttribute('aria-label', `Sent bitrate over the last ${data.length} seconds: now ${now.value} ${now.unit}, peak ${top.value} ${top.unit}`);
  }

  log(message) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    const d = new Date();
    time.textContent = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    li.append(time, message);
    this.ui.log.prepend(li);
    while (this.ui.log.children.length > 4) this.ui.log.lastElementChild.remove();
  }
}

const root = document.querySelector('[data-lab]');
if (root) new LiveLab(root);
