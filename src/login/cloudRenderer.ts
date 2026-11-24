import { screenVertex, volumeFragment, dustVertex, dustFragment, starsVertex, starsFragment } from './cloudShaders';

const TAU = Math.PI * 2;
type Scene = { width: number; height: number; scale: number; radius: number };
type Draw = (angle: number, scene: Scene, lookX: number, lookY: number) => void;

function seededRandom() {
  let seed = 89017;
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function makeStars(random: () => number) {
  const stars: number[] = [];
  for (const [group, count] of [360, 1450, 320].entries()) {
    for (let i = 0; i < count; i++) stars.push(random(), random(), random(), group);
  }
  const highlights = [[.08,.51], [.21,.44], [.32,.70], [.26,.31], [.42,.85], [.56,.90], [.73,.74], [.81,.62], [.83,.39], [.93,.55]];
  highlights.forEach(([x, y], i) => stars.push(x, y, i % 3 === 0 ? .998 : .93, 3));
  return new Float32Array(stars);
}

function makeDust(image: HTMLImageElement, random: () => number) {
  const sample = document.createElement('canvas');
  sample.width = image.naturalWidth;
  sample.height = image.naturalHeight;
  const context = sample.getContext('2d')!;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  // The same ellipsoids as the volume shader place bright texture samples at different depths.
  const lobes = [
    [-.02,.26,.46,.43,.47,-.11], [-.46,.075,.37,.33,.37,-.035], [.43,.025,.44,.33,.41,.025],
    [-.61,-.155,.35,.28,.34,.105], [.65,-.19,.30,.26,.31,.08], [.02,-.24,.68,.23,.31,.16],
  ];
  const points: number[] = [];
  for (let i = 0; i < 195000; i++) {
    const u = random(), v = random();
    const offset = (Math.floor(v * sample.height) * sample.width + Math.floor(u * sample.width)) * 4;
    const luminance = (pixels[offset + 1] * .7 + pixels[offset + 2] * .3) / 255;
    if (random() > pixels[offset + 3] / 255 * (.12 + luminance * .9)) continue;
    const x = 2 * u - 1, y = 1.075 - 2 * v;
    let z = -.30;
    for (const [cx, cy, rx, ry, rz, cz] of lobes) {
      const depth = 1 - ((x - cx) / rx) ** 2 - ((y - cy) / ry) ** 2;
      if (depth > 0) z = Math.max(z, cz + Math.sqrt(depth) * rz);
    }
    points.push(x, y, z + .08 - random() ** 2 * .35, random());
  }
  return new Float32Array(points);
}

function webGLRenderer(gl: WebGLRenderingContext, image: HTMLImageElement, stars: Float32Array, random: () => number): Draw {
  function layer(vertex: string, fragment: string, attribute: string, data: Float32Array, size: number, mode: number) {
    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.bindAttribLocation(program, 0, attribute);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) || 'Shader link failed');
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const location = (name: string) => gl.getUniformLocation(program, name);
    const res = location('res'), center = location('center'), unit = location('unit');
    const time = location('t'), pixel = location('px'), look = location('look');
    const count = data.length / size;
    return (angle, scene, x, y) => {
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, size, gl.FLOAT, false, 0, 0);
      gl.uniform2f(res, scene.width, scene.height);
      gl.uniform2f(center, scene.width * .5, scene.height * .535);
      gl.uniform1f(unit, scene.radius);
      gl.uniform1f(time, angle);
      gl.uniform1f(pixel, scene.scale);
      gl.uniform2f(look, x, y);
      gl.drawArrays(mode, 0, count);
    };
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  const cloud = layer(screenVertex, volumeFragment, 'pos', new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), 2, gl.TRIANGLES);
  const dust = layer(dustVertex, dustFragment, 'bead', makeDust(image, random), 4, gl.POINTS);
  const sky = layer(starsVertex, starsFragment, 'seed', stars, 4, gl.POINTS);
  return (angle, scene, x, y) => {
    gl.viewport(0, 0, scene.width, scene.height);
    gl.disable(gl.BLEND);
    cloud(angle, scene, x, y);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    dust(angle, scene, x, y);
    sky(angle, scene, x, y);
  };
}

function canvasRenderer(ctx: CanvasRenderingContext2D, image: HTMLImageElement, stars: Float32Array): Draw {
  return (angle, { width, height, radius, scale }) => {
    ctx.clearRect(0, 0, width, height);
    const cx = width * .5, cy = height * .465;
    ctx.globalAlpha = .85;
    for (let row = 0; row < image.height; row += 4) {
      const v = row / image.height;
      const rows = Math.min(4, image.height - row);
      const x = cx - radius + Math.sin(v * 10 + angle) * radius * .008;
      ctx.drawImage(image, 0, row, image.width, rows, x, cy + (2*v - 1.075)*radius, 2*radius, rows/image.height*2*radius + .16);
    }
    for (let i = 0; i < stars.length; i += 4) {
      const a = stars[i], b = stars[i + 1], c = stars[i + 2], group = stars[i + 3];
      let x = a * width, y = b * height, fade = 1;
      if (group === 1) {
        const progress = (a + angle / TAU) % 1;
        const q = (progress - .5) * 2.98;
        x = cx + q * radius;
        y = cy - (.14*q + .18*Math.sin(q*3.8 + .27*Math.sin(angle)) - .095 + (b-.5)*(.038+.23*c*c))*radius;
        fade = Math.min(1, progress*8, (1-progress)*8);
      } else if (group === 2) {
        const orbit = a * TAU + angle;
        x = cx + (1.02+.23*b)*Math.cos(orbit)*radius;
        y = cy - ((.36+.09*b)*Math.sin(orbit) + .135*Math.cos(orbit))*radius;
      } else if (group === 3) {
        x = cx + ((a-.5)*2.65 + .012*Math.sin(angle+9*b))*radius;
        y = cy - ((b-.5)*1.32 + .012*Math.cos(angle+11*a))*radius;
      }
      ctx.globalAlpha = (.22 + .69 * (.5 + .5 * Math.cos(angle*2 + 6*a + 6*b)) ** 4) * fade;
      ctx.fillStyle = c > .985 ? '#e0e6ff' : '#7a9cd9';
      ctx.fillRect(x, y, (c > .985 ? 2.4 : 1)*scale, scale);
    }
    ctx.globalAlpha = 1;
  };
}

export function mountCloud(host: HTMLElement, image: HTMLImageElement) {
  const random = seededRandom();
  const stars = makeStars(random);
  let canvas = document.createElement('canvas');
  let gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
  let paint: Draw;
  if (gl) {
    try { paint = webGLRenderer(gl, image, stars, random); }
    catch { gl.getExtension('WEBGL_lose_context')?.loseContext(); gl = null; canvas = document.createElement('canvas'); }
  }
  if (!paint) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};
    paint = canvasRenderer(ctx, image, stars);
  }
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let scene: Scene, frame = 0, lastTime = 0, elapsed = 0;
  let targetX = 0, targetY = 0, viewX = 0, viewY = 0;
  host.appendChild(canvas);

  function draw() {
    viewX += (targetX - viewX) * .09;
    viewY += (targetY - viewY) * .09;
    paint((elapsed % 20000) / 20000 * TAU, scene, viewX, viewY);
  }
  function resize() {
    const { clientWidth: w, clientHeight: h } = host;
    if (!w || !h) return;
    const scale = Math.min(devicePixelRatio || 1, 2.5, 4800/Math.max(w,h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    scene = { width: canvas.width, height: canvas.height, radius: Math.min(w < 600 ? w*.68 : w*.435, h*.60)*scale, scale };
    draw();
  }
  function loop(now: number) {
    const delta = now - lastTime;
    if (scene && delta >= 1000/30 - 1) {
      elapsed += Math.min(delta, 240);
      lastTime = now;
      draw();
    }
    frame = requestAnimationFrame(loop);
  }
  function sync() {
    cancelAnimationFrame(frame);
    if (motion.matches) {
      targetX = targetY = viewX = viewY = elapsed = 0;
      if (scene) draw();
    } else if (!document.hidden) {
      lastTime = performance.now();
      frame = requestAnimationFrame(loop);
    }
  }
  function pointer(event: PointerEvent) {
    const bounds = host.getBoundingClientRect();
    targetX = ((event.clientX-bounds.left)/bounds.width - .5)*.19;
    targetY = (.5 - (event.clientY-bounds.top)/bounds.height)*.11;
  }
  function resetPointer() { targetX = targetY = 0; }
  function lostContext() {
    // Show the underlying texture while the GPU is unavailable.
    canvas.hidden = true;
    cleanup();
  }
  function cleanup() {
    cancelAnimationFrame(frame);
    observer.disconnect();
    document.removeEventListener('pointermove', pointer);
    document.removeEventListener('pointerleave', resetPointer);
    document.removeEventListener('visibilitychange', sync);
    motion.removeEventListener('change', sync);
    canvas.removeEventListener('webglcontextlost', lostContext);
    canvas.remove();
    if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  const observer = new ResizeObserver(resize);
  resize();
  observer.observe(host);
  document.addEventListener('pointermove', pointer, { passive: true });
  document.addEventListener('pointerleave', resetPointer);
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);
  canvas.addEventListener('webglcontextlost', lostContext);
  sync();
  return cleanup;
}
