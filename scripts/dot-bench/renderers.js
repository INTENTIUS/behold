// Six ways to draw N dots that recolour and move every frame (#457).
//
// Each renderer takes the same state object and exposes the same four calls,
// so scripts/dot-bench/bench.js can drive them identically and the numbers
// differ only by how the dots reach the screen:
//
//   create(host, state) -> { frame(changed), hit(x, y), destroy() }
//
// `state` is { n, x: Float32Array, y: Float32Array, color: Uint8Array (palette
// index), r: dot radius in CSS px, palette: ["#rrggbb", ...], w, h }.
// `frame(changed)` is called once per animation frame after the bench mutated
// `state`; `changed` lists the indices whose colour or position moved, which a
// retained renderer uses and an immediate one ignores.
//
// hit testing: SVG uses the browser's own `elementFromPoint`. Every other
// renderer draws pixels the DOM cannot see, so they share one uniform-grid
// index over the dot centres (./grid.js), which is what behold would write
// whichever of them it picked.

import { GridIndex } from "./grid.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function sizedCanvas(host, state) {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(state.w * dpr);
  canvas.height = Math.round(state.h * dpr);
  canvas.style.width = `${state.w}px`;
  canvas.style.height = `${state.h}px`;
  host.appendChild(canvas);
  return { canvas, dpr };
}

function gridHit(state) {
  const grid = new GridIndex(state);
  return {
    rebuild: () => grid.rebuild(state),
    hit: (x, y) => grid.nearest(state, x, y),
  };
}

/** SVG, one <circle> per dot, created once; a frame sets the attributes that changed. */
export function svgMutate(host, state) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", state.w);
  svg.setAttribute("height", state.h);
  const circles = new Array(state.n);
  for (let i = 0; i < state.n; i++) {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", state.x[i]);
    c.setAttribute("cy", state.y[i]);
    c.setAttribute("r", state.r);
    c.setAttribute("fill", state.palette[state.color[i]]);
    c.dataset.i = i;
    circles[i] = c;
    svg.appendChild(c);
  }
  host.appendChild(svg);
  return {
    frame(changed) {
      for (const i of changed) {
        const c = circles[i];
        c.setAttribute("fill", state.palette[state.color[i]]);
        c.setAttribute("cx", state.x[i]);
        c.setAttribute("cy", state.y[i]);
      }
    },
    hit(x, y) {
      const el = document.elementFromPoint(x, y);
      return el && el.dataset && el.dataset.i !== undefined ? Number(el.dataset.i) : -1;
    },
    destroy() { svg.remove(); },
  };
}

/** SVG rebuilt whole every frame, the way behold swaps a pinhole frame into `#graph` today. */
export function svgReplace(host, state) {
  const box = document.createElement("div");
  host.appendChild(box);
  const paint = () => {
    let s = `<svg xmlns="${SVG_NS}" width="${state.w}" height="${state.h}">`;
    for (let i = 0; i < state.n; i++) {
      s += `<circle cx="${state.x[i].toFixed(1)}" cy="${state.y[i].toFixed(1)}" r="${state.r}" fill="${state.palette[state.color[i]]}" data-i="${i}"/>`;
    }
    box.innerHTML = s + "</svg>";
  };
  paint();
  return {
    frame() { paint(); },
    hit(x, y) {
      const el = document.elementFromPoint(x, y);
      return el && el.dataset && el.dataset.i !== undefined ? Number(el.dataset.i) : -1;
    },
    destroy() { box.remove(); },
  };
}

/** Canvas 2D, redrawn whole each frame, one path per palette colour. */
export function canvas2d(host, state) {
  const { canvas, dpr } = sizedCanvas(host, state);
  const ctx = canvas.getContext("2d");
  const grid = gridHit(state);
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, state.w, state.h);
    for (let p = 0; p < state.palette.length; p++) {
      ctx.beginPath();
      for (let i = 0; i < state.n; i++) {
        if (state.color[i] !== p) continue;
        ctx.moveTo(state.x[i] + state.r, state.y[i]);
        ctx.arc(state.x[i], state.y[i], state.r, 0, Math.PI * 2);
      }
      ctx.fillStyle = state.palette[p];
      ctx.fill();
    }
  };
  draw();
  return {
    frame(changed, moved) { if (moved) grid.rebuild(); draw(); },
    hit: grid.hit,
    destroy() { canvas.remove(); },
  };
}

const VS = `
attribute vec2 a_pos; attribute vec3 a_col;
uniform vec2 u_size; uniform float u_pt;
varying vec3 v_col;
void main() {
  vec2 clip = (a_pos / u_size) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = u_pt;
  v_col = a_col;
}`;
const FS = `
precision mediump float; varying vec3 v_col;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  gl_FragColor = vec4(v_col, 1.0);
}`;

function packGl(state, pos, col, rgb) {
  for (let i = 0; i < state.n; i++) {
    pos[2 * i] = state.x[i];
    pos[2 * i + 1] = state.y[i];
    const c = rgb[state.color[i]];
    col[3 * i] = c[0]; col[3 * i + 1] = c[1]; col[3 * i + 2] = c[2];
  }
}

/** Raw WebGL 1, gl.POINTS, both attribute buffers re-uploaded whole each frame. No library. */
export function webglRaw(host, state) {
  const { canvas, dpr } = sizedCanvas(host, state);
  const gl = canvas.getContext("webgl", { antialias: true });
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const rgb = state.palette.map(hexToRgb);
  const pos = new Float32Array(state.n * 2);
  const col = new Float32Array(state.n * 3);
  const posBuf = gl.createBuffer();
  const colBuf = gl.createBuffer();
  const aPos = gl.getAttribLocation(prog, "a_pos");
  const aCol = gl.getAttribLocation(prog, "a_col");
  gl.uniform2f(gl.getUniformLocation(prog, "u_size"), state.w, state.h);
  gl.uniform1f(gl.getUniformLocation(prog, "u_pt"), state.r * 2 * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(1, 1, 1, 1);
  const grid = gridHit(state);
  const draw = () => {
    packGl(state, pos, col, rgb);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, state.n);
  };
  draw();
  return {
    frame(changed, moved) { if (moved) grid.rebuild(); draw(); },
    hit: grid.hit,
    destroy() { canvas.remove(); },
  };
}

/** regl (the UMD build's global `createREGL`), the same points and shaders as webglRaw. */
export function regl(host, state) {
  const { canvas, dpr } = sizedCanvas(host, state);
  const r = window.createREGL({ canvas, attributes: { antialias: true } });
  const rgb = state.palette.map(hexToRgb);
  const pos = new Float32Array(state.n * 2);
  const col = new Float32Array(state.n * 3);
  const posBuf = r.buffer({ usage: "dynamic", data: pos });
  const colBuf = r.buffer({ usage: "dynamic", data: col });
  const cmd = r({
    vert: VS, frag: FS,
    attributes: { a_pos: posBuf, a_col: colBuf },
    uniforms: { u_size: [state.w, state.h], u_pt: state.r * 2 * dpr },
    count: state.n,
    primitive: "points",
  });
  const grid = gridHit(state);
  const draw = () => {
    packGl(state, pos, col, rgb);
    posBuf.subdata(pos);
    colBuf.subdata(col);
    r.clear({ color: [1, 1, 1, 1] });
    cmd();
  };
  draw();
  return {
    frame(changed, moved) { if (moved) grid.rebuild(); draw(); },
    hit: grid.hit,
    destroy() { r.destroy(); canvas.remove(); },
  };
}

/** PixiJS v8, one Sprite per dot from one circle texture, tinted; the scene graph is retained. */
export async function pixi(host, state) {
  const PIXI = window.PIXI;
  const app = new PIXI.Application();
  await app.init({ width: state.w, height: state.h, background: "#ffffff", antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true, autoStart: false, preference: "webgl" });
  host.appendChild(app.canvas);
  const g = new PIXI.Graphics().circle(0, 0, state.r * 4).fill(0xffffff);
  const tex = app.renderer.generateTexture(g);
  const tints = state.palette.map((h) => parseInt(h.slice(1), 16));
  const sprites = new Array(state.n);
  for (let i = 0; i < state.n; i++) {
    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5);
    s.scale.set(0.25);
    s.x = state.x[i]; s.y = state.y[i];
    s.tint = tints[state.color[i]];
    sprites[i] = s;
    app.stage.addChild(s);
  }
  app.render();
  const grid = gridHit(state);
  return {
    frame(changed, moved) {
      for (const i of changed) {
        const s = sprites[i];
        s.tint = tints[state.color[i]];
        s.x = state.x[i]; s.y = state.y[i];
      }
      if (moved) grid.rebuild();
      app.render();
    },
    hit: grid.hit,
    destroy() { app.destroy(true, { children: true, texture: true }); },
  };
}

export const RENDERERS = { "svg-mutate": svgMutate, "svg-replace": svgReplace, canvas2d, "webgl-raw": webglRaw, regl, pixi };
