// Experimental: the cursor stirs a thin layer of liquid over the Home hero. Pointer
// motion injects velocity and dye into a small GPU stable-fluid simulation. The dye
// never shows itself: it marks the recent wake, and only inside that wake is a visual
// copy of the hero refracted by the flow. Everywhere else the real DOM shows untouched.
(() => {
  // ─── Tuning ─────────────────────────────────────────────────
  // Velocity/pressure cells along the Home band's short axis.
  const SIM_RESOLUTION = 128;
  // Dye (trail mask) cells along the Home band's short axis.
  const DYE_RESOLUTION = 256;
  // Width of the pointer's push and dye (Gaussian radius around its path) in CSS px.
  const FORCE_RADIUS = 28;
  // Fluid speed under the pointer as a share of pointer speed, at full sweep speed.
  const FORCE_GAIN = 0.6;
  // Pointer speed (CSS px per second) at which FORCE_GAIN and full dye are reached.
  const VELOCITY_FULL = 1600;
  // Below VELOCITY_FULL, gain and dye are scaled by (speed / VELOCITY_FULL) ^ FORCE_CURVE,
  // so slow movements leave a fainter, narrower wake than quick sweeps.
  const FORCE_CURVE = 0.6;
  // How strongly the pointer drags the fluid toward its target speed (share per 60fps frame).
  const FORCE_COUPLING = 0.5;
  // Vorticity confinement: how much the wake curls.
  const CURL = 12;
  // Decay rates per second. Dye decay sets how long the wake stays visible.
  const VELOCITY_DISSIPATION = 1.5;
  const DYE_DISSIPATION = 2.2;
  const PRESSURE_ITERATIONS = 20;
  // Share of the previous frame's pressure used to warm-start the solver.
  const PRESSURE_RETAIN = 0.8;
  // Dye level where the wake starts affecting the page, and the ramp above it.
  const TRAIL_THRESHOLD = 0.12;
  const TRAIL_SOFTNESS = 0.25;
  // Seconds of flow: page displacement in px = fluid speed in px/s × this.
  const DISTORTION_STRENGTH = 0.06;
  // Largest displacement of page content in CSS px.
  const MAX_DISPLACEMENT = 36;
  // Displacement in CSS px below which the real DOM shows through untouched.
  const REVEAL_THRESHOLD = 0.5;
  // Device pixel ratio cap for the overlay canvas and the hero copy.
  const MAX_DPR = 2;
  // Distance in CSS px over which the wake fades out at the Home band's edges.
  const EDGE_FADE = 24;
  // Prototype aid: tints the (otherwise invisible) wake so its motion can be judged.
  const DEBUG_TRAIL = true;
  const DEBUG_OPACITY = 0.22;

  const page = document.querySelector("main.page");
  const foldHero = document.querySelector(".fold-hero");
  const layout = document.querySelector(".home-hero-layout");
  const portrait = document.querySelector(".home-hero-image");
  const textEls = document.querySelectorAll(
    ".home-hero-name span, .home-hero-title",
  );

  if (
    !page ||
    !foldHero ||
    !layout ||
    !portrait ||
    !textEls.length ||
    typeof window.matchMedia !== "function" ||
    !("IntersectionObserver" in window) ||
    !("ResizeObserver" in window)
  ) {
    return;
  }

  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const allowed = () =>
    finePointer.matches &&
    !reducedMotion.matches &&
    !document.body.classList.contains("sidebar-open");

  // ─── Shaders ────────────────────────────────────────────────
  const VERTEX_SHADER = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  // Simulation textures are stored with row 0 at the top of the Home band, so vUv.y
  // grows downward like CSS. Velocity is in cells per second.
  const SIM_HEADER = `#version 300 es
    precision highp float;
    precision highp sampler2D;
    in vec2 vUv;
    out vec4 outColor;
    uniform vec2 uTexel;
    vec2 dx() { return vec2(uTexel.x, 0.0); }
    vec2 dy() { return vec2(0.0, uTexel.y); }
  `;

  // Gaussian weight around the pointer's path (segment A→B, in sim cells).
  const PATH_WEIGHT = `
    uniform vec2 uA;
    uniform vec2 uB;
    uniform float uRadius;
    float pathWeight() {
      vec2 p = vUv / uTexel;
      vec2 ab = uB - uA;
      float t = clamp(dot(p - uA, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
      vec2 d = p - uA - ab * t;
      return exp(-dot(d, d) / (uRadius * uRadius));
    }
  `;

  // Drags the fluid near the pointer's path toward uTarget.
  const SPLAT_SHADER = `${SIM_HEADER}${PATH_WEIGHT}
    uniform sampler2D uVelocity;
    uniform vec2 uTarget;
    uniform float uCoupling;
    void main() {
      vec2 v = texture(uVelocity, vUv).xy;
      outColor = vec4(mix(v, uTarget, pathWeight() * uCoupling), 0.0, 1.0);
    }
  `;

  // Lays dye along the pointer's path. Max, not sum, so lingering never saturates it.
  const DYE_SPLAT_SHADER = `${SIM_HEADER}${PATH_WEIGHT}
    uniform sampler2D uDye;
    uniform float uStrength;
    void main() {
      float d = texture(uDye, vUv).x;
      outColor = vec4(max(d, pathWeight() * uStrength), 0.0, 0.0, 1.0);
    }
  `;

  const CURL_SHADER = `${SIM_HEADER}
    uniform sampler2D uVelocity;
    void main() {
      float l = texture(uVelocity, vUv - dx()).y;
      float r = texture(uVelocity, vUv + dx()).y;
      float b = texture(uVelocity, vUv - dy()).x;
      float t = texture(uVelocity, vUv + dy()).x;
      outColor = vec4(0.5 * ((r - l) - (t - b)), 0.0, 0.0, 1.0);
    }
  `;

  const VORTICITY_SHADER = `${SIM_HEADER}
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float uCurlStrength;
    uniform float uDt;
    void main() {
      float l = texture(uCurl, vUv - dx()).x;
      float r = texture(uCurl, vUv + dx()).x;
      float b = texture(uCurl, vUv - dy()).x;
      float t = texture(uCurl, vUv + dy()).x;
      float c = texture(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
      force /= length(force) + 1e-4;
      force *= uCurlStrength * c;
      force.y *= -1.0;
      vec2 v = texture(uVelocity, vUv).xy + force * uDt;
      outColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
    }
  `;

  // Carries uSource (velocity or dye, at any resolution) along the flow. uTexel is
  // always the velocity grid's texel, since velocity is in sim cells per second.
  const ADVECT_SHADER = `${SIM_HEADER}
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform float uDt;
    uniform float uDecay;
    void main() {
      vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
      outColor = vec4(texture(uSource, coord).xy * uDecay, 0.0, 1.0);
    }
  `;

  // Walls at the band edges reflect the normal velocity component.
  const DIVERGENCE_SHADER = `${SIM_HEADER}
    uniform sampler2D uVelocity;
    void main() {
      vec2 c = texture(uVelocity, vUv).xy;
      float l = vUv.x - uTexel.x < 0.0 ? -c.x : texture(uVelocity, vUv - dx()).x;
      float r = vUv.x + uTexel.x > 1.0 ? -c.x : texture(uVelocity, vUv + dx()).x;
      float b = vUv.y - uTexel.y < 0.0 ? -c.y : texture(uVelocity, vUv - dy()).y;
      float t = vUv.y + uTexel.y > 1.0 ? -c.y : texture(uVelocity, vUv + dy()).y;
      outColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
    }
  `;

  const JACOBI_SHADER = `${SIM_HEADER}
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    uniform float uRetain;
    void main() {
      float sum =
        texture(uPressure, vUv - dx()).x +
        texture(uPressure, vUv + dx()).x +
        texture(uPressure, vUv - dy()).x +
        texture(uPressure, vUv + dy()).x;
      float div = texture(uDivergence, vUv).x;
      outColor = vec4((sum * uRetain - div) * 0.25, 0.0, 0.0, 1.0);
    }
  `;

  const GRADIENT_SHADER = `${SIM_HEADER}
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    void main() {
      float l = texture(uPressure, vUv - dx()).x;
      float r = texture(uPressure, vUv + dx()).x;
      float b = texture(uPressure, vUv - dy()).x;
      float t = texture(uPressure, vUv + dy()).x;
      vec2 v = texture(uVelocity, vUv).xy - 0.5 * vec2(r - l, t - b);
      outColor = vec4(v, 0.0, 1.0);
    }
  `;

  // Positions are document CSS px. The dye masks where the page is affected; inside
  // the mask, the hero copy and the viewport-fixed page gradient are sampled against
  // the flow. Outside it, alpha is 0 and the real DOM shows through.
  const COMPOSITE_SHADER = `#version 300 es
    precision highp float;
    precision highp sampler2D;
    out vec4 outColor;
    uniform sampler2D uVelocity;
    uniform sampler2D uDye;
    uniform sampler2D uPlate;
    uniform vec2 uCanvasPx;
    uniform float uDpr;
    uniform vec2 uViewOrigin;
    uniform vec2 uBandOrigin;
    uniform vec2 uBandSize;
    uniform vec2 uCell;
    uniform vec2 uPlateOrigin;
    uniform vec2 uPlateSize;
    uniform float uScrollY;
    uniform float uViewH;
    uniform float uThreshold;
    uniform float uSoftness;
    uniform float uStrength;
    uniform float uMax;
    uniform float uReveal;
    uniform float uEdge;
    uniform vec3 uC0;
    uniform vec3 uC1;
    uniform vec3 uDebugInk;
    uniform float uDebugOpacity;
    void main() {
      vec2 local = vec2(gl_FragCoord.x, uCanvasPx.y - gl_FragCoord.y) / uDpr;
      vec2 p = uViewOrigin + local;
      vec2 bandUv = (p - uBandOrigin) / uBandSize;
      float dye = texture(uDye, bandUv).x;
      float mask = smoothstep(uThreshold, uThreshold + uSoftness, dye);
      // Everything eases to zero at the canvas border so the copy meets the real
      // page without a seam.
      vec2 toEdge = min(local, uCanvasPx / uDpr - local);
      mask *= smoothstep(0.0, uEdge, min(toEdge.x, toEdge.y));
      if (mask <= 0.0) {
        outColor = vec4(0.0);
        return;
      }

      vec2 o = -texture(uVelocity, bandUv).xy * uCell * uStrength * mask;
      float m = length(o);
      if (m > uMax) o *= uMax / m;
      float alpha = clamp(length(o) / uReveal, 0.0, 1.0);

      vec2 s = p + o;
      vec2 uv = (s - uPlateOrigin) / uPlateSize;
      vec4 plate = texture(uPlate, clamp(uv, 0.0, 1.0));
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
        plate = vec4(0.0);
      }
      vec3 grad = mix(uC0, uC1, clamp((s.y - uScrollY) / uViewH, 0.0, 1.0));
      vec4 copy = vec4((plate.rgb + grad * (1.0 - plate.a)) * alpha, alpha);

      float tint = mask * uDebugOpacity;
      outColor = vec4(uDebugInk * tint, tint) + copy * (1.0 - tint);
    }
  `;

  // ─── State ──────────────────────────────────────────────────
  let status = "idle"; // idle → starting → ready, or disabled
  let gl = null;
  let canvas = null;
  let wrap = null;
  let plateTexture = null;
  let programs = null;
  let resizeObserver = null;
  let themeObserver = null;
  let measureTimer = 0;
  let skipFirstResize = true;
  const cleanups = [];

  const band = { left: 0, top: 0, width: 0, height: 0 };
  const view = { x: 0, y: 0, pxW: 1, pxH: 1 };
  const plate = { x: 0, y: 0, w: 1, h: 1, ready: false };
  const sim = { w: 0, h: 0, cellX: 1, cellY: 1 };
  const dyeGrid = { w: 0, h: 0 };
  let targets = null;
  let dpr = 1;
  let colors = null;
  let debugInk = [0, 0, 0];
  let isDark = null;

  let homeVisible = false;
  let pointerX = 0;
  let pointerY = 0;
  let lastEventX = 0;
  let lastEventY = 0;
  let lastEventTime = 0;
  let tracking = false;
  let pendingX = 0;
  let pendingY = 0;
  let pointerVelX = 0;
  let pointerVelY = 0;

  // Upper bound on any dye value, so settling never needs a GPU readback: advection
  // only mixes existing values and dissipation only shrinks them.
  let dyePeak = 0;
  let shown = false;
  let rafId = 0;
  let lastTime = 0;

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  // ─── Lifecycle ──────────────────────────────────────────────
  function disable() {
    status = "disabled";
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    clearTimeout(measureTimer);
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    if (resizeObserver) resizeObserver.disconnect();
    if (themeObserver) themeObserver.disconnect();
    if (visibilityObserver) visibilityObserver.disconnect();
    if (wrap) wrap.remove();
    wrap = canvas = gl = plateTexture = programs = targets = null;
  }

  function start() {
    status = "starting";
    const run = () => {
      try {
        init();
      } catch (error) {
        disable();
      }
    };
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(run, { timeout: 300 });
    } else {
      setTimeout(run, 50);
    }
  }

  function init() {
    if (status !== "starting") return;

    colors = readColors();
    debugInk = readInk();
    isDark = document.body.classList.contains("dark");

    canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: true,
    });
    if (!gl) throw new Error("WebGL2 unavailable");
    if (
      !gl.getExtension("EXT_color_buffer_float") &&
      !gl.getExtension("EXT_color_buffer_half_float")
    ) {
      throw new Error("Float render targets unavailable");
    }

    programs = {
      splat: createProgram(SPLAT_SHADER),
      dyeSplat: createProgram(DYE_SPLAT_SHADER),
      curl: createProgram(CURL_SHADER),
      vorticity: createProgram(VORTICITY_SHADER),
      advect: createProgram(ADVECT_SHADER),
      divergence: createProgram(DIVERGENCE_SHADER),
      jacobi: createProgram(JACOBI_SHADER),
      gradient: createProgram(GRADIENT_SHADER),
      composite: createProgram(COMPOSITE_SHADER),
    };

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    plateTexture = createTexture();
    gl.disable(gl.BLEND);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL setup failed");

    wrap = document.createElement("div");
    wrap.className = "home-fluid";
    wrap.setAttribute("aria-hidden", "true");
    wrap.appendChild(canvas);

    on(canvas, "webglcontextlost", disable);

    measure();
    document.body.appendChild(wrap);
    status = "ready";

    resizeObserver = new ResizeObserver(() => {
      if (skipFirstResize) {
        skipFirstResize = false;
        return;
      }
      scheduleMeasure();
    });
    resizeObserver.observe(page);
    resizeObserver.observe(layout);
    on(window, "resize", scheduleMeasure);

    themeObserver = new MutationObserver(onBodyClassChange);
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    on(portrait, "load", scheduleMeasure);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (status === "ready") scheduleMeasure();
      });
    }
  }

  // ─── WebGL helpers ──────────────────────────────────────────
  function createProgram(fragmentSource) {
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || "Shader failed");
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.bindAttribLocation(program, 0, "aPos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Link failed");
    }
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i += 1) {
      const { name } = gl.getActiveUniform(program, i);
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  function createTexture() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  function createTarget(w, h, internalFormat, format) {
    const texture = createTexture();
    gl.texImage2D(
      gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl.HALF_FLOAT, null,
    );
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Render target unsupported");
    }
    return { texture, fbo, w, h };
  }

  function createPingPong(w, h, internalFormat, format) {
    return {
      read: createTarget(w, h, internalFormat, format),
      write: createTarget(w, h, internalFormat, format),
      swap() {
        [this.read, this.write] = [this.write, this.read];
      },
    };
  }

  function deleteTargets() {
    if (!targets) return;
    for (const entry of Object.values(targets)) {
      for (const target of entry.read ? [entry.read, entry.write] : [entry]) {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.fbo);
      }
    }
    targets = null;
  }

  function createSimTargets(w, h, dyeW, dyeH) {
    deleteTargets();
    targets = {
      velocity: createPingPong(w, h, gl.RG16F, gl.RG),
      pressure: createPingPong(w, h, gl.R16F, gl.RED),
      dye: createPingPong(dyeW, dyeH, gl.R16F, gl.RED),
      divergence: createTarget(w, h, gl.R16F, gl.RED),
      curl: createTarget(w, h, gl.R16F, gl.RED),
    };
  }

  function clearSimTargets() {
    if (!targets) return;
    gl.clearColor(0, 0, 0, 0);
    for (const entry of Object.values(targets)) {
      for (const target of entry.read ? [entry.read, entry.write] : [entry]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
  }

  // Draws one full-screen pass into `target` (or the canvas when null).
  function pass(prog, target, textures, setUniforms) {
    gl.useProgram(prog.program);
    const u = prog.uniforms;
    let unit = 0;
    for (const name in textures) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, textures[name]);
      gl.uniform1i(u[name], unit);
      unit += 1;
    }
    if (u.uTexel) gl.uniform2f(u.uTexel, 1 / sim.w, 1 / sim.h);
    if (setUniforms) setUniforms(u);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, view.pxW, view.pxH);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // The two stops of the viewport-fixed body gradient (--page-bg) as sRGB 0–1.
  function readColors() {
    const bg = getComputedStyle(document.body).getPropertyValue("--page-bg");
    const hex = bg.match(/#[0-9a-f]{6}\b/gi);
    if (!hex || hex.length < 2) throw new Error("Unexpected --page-bg");
    return hex
      .slice(0, 2)
      .map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255));
  }

  // The hero text colour as sRGB 0–1, used for the DEBUG_TRAIL tint.
  function readInk() {
    const rgb = getComputedStyle(textEls[0]).color.match(/[\d.]+/g);
    if (!rgb || rgb.length < 3) return [0, 0, 0];
    return rgb.slice(0, 3).map((v) => Number(v) / 255);
  }

  function onBodyClassChange() {
    if (status !== "ready") return;
    const dark = document.body.classList.contains("dark");
    if (dark !== isDark) {
      isDark = dark;
      try {
        colors = readColors();
        debugInk = readInk();
        buildPlate();
      } catch (error) {
        disable();
        return;
      }
    }
    if (!allowed()) reset();
  }

  // ─── Layout: Home band, overlay canvas, hero copy ──────────
  function scheduleMeasure() {
    if (status !== "ready") return;
    plate.ready = false;
    reset();
    clearTimeout(measureTimer);
    measureTimer = setTimeout(() => {
      try {
        measure();
      } catch (error) {
        disable();
      }
    }, 120);
  }

  function measure() {
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const sx = window.scrollX;
    const sy = window.scrollY;

    // Home band (fluid domain): from the sidebar edge to the viewport edge, down to
    // the end of the fold.
    const pageRect = page.getBoundingClientRect();
    const pageStyle = getComputedStyle(page);
    band.left = Math.round(pageRect.left - parseFloat(pageStyle.marginLeft) + sx);
    band.top = Math.round(pageRect.top + sy);
    band.width = Math.max(
      1,
      Math.round(document.documentElement.clientWidth + sx) - band.left,
    );
    band.height = Math.max(
      1,
      Math.round(foldHero.getBoundingClientRect().bottom + sy) - band.top,
    );

    const shortSide = Math.min(band.width, band.height);
    const cell = shortSide / SIM_RESOLUTION;
    const simW = Math.max(8, Math.round(band.width / cell));
    const simH = Math.max(8, Math.round(band.height / cell));
    const dyeCell = shortSide / DYE_RESOLUTION;
    const dyeW = Math.max(8, Math.round(band.width / dyeCell));
    const dyeH = Math.max(8, Math.round(band.height / dyeCell));
    if (
      simW !== sim.w ||
      simH !== sim.h ||
      dyeW !== dyeGrid.w ||
      dyeH !== dyeGrid.h ||
      !targets
    ) {
      createSimTargets(simW, simH, dyeW, dyeH);
      sim.w = simW;
      sim.h = simH;
      dyeGrid.w = dyeW;
      dyeGrid.h = dyeH;
    }
    sim.cellX = band.width / simW;
    sim.cellY = band.height / simH;
    clearSimTargets();

    // Overlay canvas: the whole Home band.
    view.x = band.left;
    view.y = band.top;
    view.pxW = Math.max(1, Math.ceil(band.width * dpr));
    view.pxH = Math.max(1, Math.ceil(band.height * dpr));
    canvas.width = view.pxW;
    canvas.height = view.pxH;
    wrap.style.left = `${view.x}px`;
    wrap.style.top = `${view.y}px`;
    wrap.style.width = `${view.pxW / dpr}px`;
    wrap.style.height = `${view.pxH / dpr}px`;

    buildPlate();
  }

  // Rasterises the portrait and hero text, at their exact document positions,
  // into one texture. Runs only on layout, theme, font or image changes.
  function buildPlate() {
    plate.ready = false;
    if (!portrait.complete || !portrait.naturalWidth) return;

    const sx = window.scrollX;
    const sy = window.scrollY;
    const rect = layout.getBoundingClientRect();
    const pad = 8;
    const x0 = Math.floor((rect.left + sx - pad) * dpr) / dpr;
    const y0 = Math.floor((rect.top + sy - pad) * dpr) / dpr;
    const pxW = Math.ceil((rect.width + pad * 2) * dpr) + 1;
    const pxH = Math.ceil((rect.height + pad * 2) * dpr) + 1;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (pxW > maxSize || pxH > maxSize) throw new Error("Hero too large");

    const source = document.createElement("canvas");
    source.width = pxW;
    source.height = pxH;
    const ctx = source.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    ctx.setTransform(dpr, 0, 0, dpr, -x0 * dpr, -y0 * dpr);

    drawPortrait(ctx, sx, sy);
    const range = document.createRange();
    for (const el of textEls) drawText(ctx, el, range, sx, sy);

    gl.bindTexture(gl.TEXTURE_2D, plateTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("Texture upload failed");
    source.width = source.height = 0;

    plate.x = x0;
    plate.y = y0;
    plate.w = pxW / dpr;
    plate.h = pxH / dpr;
    plate.ready = true;
  }

  function drawPortrait(ctx, sx, sy) {
    const r = portrait.getBoundingClientRect();
    const x = r.left + sx;
    const y = r.top + sy;
    const w = r.width;
    const h = r.height;
    const nw = portrait.naturalWidth;
    const nh = portrait.naturalHeight;

    // object-fit: cover; object-position: center top. Only the aspect ratio is used:
    // for srcset images, naturalWidth and drawImage source pixels can disagree.
    const scale = Math.max(w / nw, h / nh);
    const dw = nw * scale;
    const dh = nh * scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(portrait, x + (w - dw) / 2, y, dw, dh);

    // Mirrors the .home-hero-image mask-image fade in style.css.
    const rem =
      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const at = (offset) => Math.min(1, Math.max(0, (h - offset) / h));
    const fade = ctx.createLinearGradient(0, y, 0, y + h);
    fade.addColorStop(0, "rgba(0, 0, 0, 1)");
    fade.addColorStop(at(6.5 * rem), "rgba(0, 0, 0, 1)");
    fade.addColorStop(at(2.5 * rem), "rgba(0, 0, 0, 0.7)");
    fade.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = fade;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  function drawText(ctx, el, range, sx, sy) {
    const node = el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;

    const style = getComputedStyle(el);
    let text = node.data;
    if (style.textTransform === "uppercase") text = text.toUpperCase();
    const spacing =
      style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing) || 0;
    const canSpace = "letterSpacing" in ctx;

    ctx.save();
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.fillStyle = style.color;
    ctx.globalAlpha = parseFloat(style.opacity) || 1;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    if ("fontKerning" in ctx && style.fontKerning) {
      ctx.fontKerning = style.fontKerning;
    }

    for (const [start, end] of lineSegments(node, range)) {
      range.setStart(node, start);
      range.setEnd(node, end);
      const lineRect = range.getBoundingClientRect();
      const line = text.slice(start, end);

      if (canSpace) ctx.letterSpacing = `${spacing}px`;
      const metrics = ctx.measureText(line);
      const ascent = metrics.fontBoundingBoxAscent;
      const descent = metrics.fontBoundingBoxDescent;
      if (!Number.isFinite(ascent) || !Number.isFinite(descent)) {
        throw new Error("Font metrics unavailable");
      }
      // Browsers snap DOM text baselines to whole device pixels.
      const baseline =
        Math.round(
          (lineRect.top + sy + (lineRect.height - (ascent + descent)) / 2 + ascent) *
            dpr,
        ) / dpr;

      // Whole-line draw keeps the font's own shaping; per-character is the fallback.
      const widthMatches =
        (canSpace || spacing === 0) &&
        Math.abs(metrics.width - lineRect.width) <= 0.5 + Math.abs(spacing);

      if (widthMatches) {
        ctx.fillText(line, lineRect.left + sx, baseline);
      } else {
        if (canSpace) ctx.letterSpacing = "0px";
        for (let i = start; i < end; i += 1) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const charRect = range.getBoundingClientRect();
          if (!charRect.width) continue;
          ctx.fillText(text[i], charRect.left + sx, baseline);
        }
      }
    }

    ctx.restore();
  }

  // [start, end) offsets of each rendered line of a text node, whitespace-trimmed.
  function lineSegments(node, range) {
    const text = node.data;
    range.selectNodeContents(node);
    const trim = (start, end) => {
      while (start < end && /\s/.test(text[start])) start += 1;
      while (end > start && /\s/.test(text[end - 1])) end -= 1;
      return [start, end];
    };

    if (range.getClientRects().length <= 1) {
      const whole = trim(0, text.length);
      return whole[0] < whole[1] ? [whole] : [];
    }

    const segments = [];
    let lineStart = 0;
    let lineTop = null;
    for (let i = 0; i < text.length; i += 1) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      if (!r) continue;
      if (lineTop === null) {
        lineTop = r.top;
      } else if (Math.abs(r.top - lineTop) > r.height / 2) {
        segments.push(trim(lineStart, i));
        lineStart = i;
        lineTop = r.top;
      }
    }
    segments.push(trim(lineStart, text.length));
    return segments.filter(([start, end]) => start < end);
  }

  // ─── Simulation ─────────────────────────────────────────────
  function splat(dt) {
    if (!pendingX && !pendingY) return;
    const moveX = pendingX;
    const moveY = pendingY;
    pendingX = pendingY = 0;

    const speed = Math.hypot(pointerVelX, pointerVelY);
    if (speed < 1) return;
    const strength = Math.pow(Math.min(speed / VELOCITY_FULL, 1), FORCE_CURVE);
    const gain = FORCE_GAIN * strength;
    const endX = pointerX + window.scrollX - band.left;
    const endY = pointerY + window.scrollY - band.top;
    const coupling = 1 - Math.pow(1 - FORCE_COUPLING, dt * 60);
    const { velocity, dye } = targets;
    const setPath = (u) => {
      gl.uniform2f(u.uA, (endX - moveX) / sim.cellX, (endY - moveY) / sim.cellY);
      gl.uniform2f(u.uB, endX / sim.cellX, endY / sim.cellY);
      gl.uniform1f(u.uRadius, FORCE_RADIUS / Math.max(sim.cellX, sim.cellY));
    };

    pass(programs.splat, velocity.write, {
      uVelocity: velocity.read.texture,
    }, (u) => {
      setPath(u);
      gl.uniform2f(
        u.uTarget,
        (pointerVelX * gain) / sim.cellX,
        (pointerVelY * gain) / sim.cellY,
      );
      gl.uniform1f(u.uCoupling, coupling);
    });
    velocity.swap();

    pass(programs.dyeSplat, dye.write, { uDye: dye.read.texture }, (u) => {
      setPath(u);
      gl.uniform1f(u.uStrength, strength);
    });
    dye.swap();

    dyePeak = Math.max(dyePeak, strength);
  }

  function step(dt) {
    const { velocity, pressure, dye, divergence, curl } = targets;

    pass(programs.curl, curl, { uVelocity: velocity.read.texture });

    pass(programs.vorticity, velocity.write, {
      uVelocity: velocity.read.texture,
      uCurl: curl.texture,
    }, (u) => {
      gl.uniform1f(u.uCurlStrength, CURL);
      gl.uniform1f(u.uDt, dt);
    });
    velocity.swap();

    pass(programs.divergence, divergence, { uVelocity: velocity.read.texture });

    for (let i = 0; i < PRESSURE_ITERATIONS; i += 1) {
      pass(programs.jacobi, pressure.write, {
        uPressure: pressure.read.texture,
        uDivergence: divergence.texture,
      }, (u) => gl.uniform1f(u.uRetain, i === 0 ? PRESSURE_RETAIN : 1));
      pressure.swap();
    }

    pass(programs.gradient, velocity.write, {
      uPressure: pressure.read.texture,
      uVelocity: velocity.read.texture,
    });
    velocity.swap();

    pass(programs.advect, velocity.write, {
      uVelocity: velocity.read.texture,
      uSource: velocity.read.texture,
    }, (u) => {
      gl.uniform1f(u.uDt, dt);
      gl.uniform1f(u.uDecay, Math.exp(-VELOCITY_DISSIPATION * dt));
    });
    velocity.swap();

    pass(programs.advect, dye.write, {
      uVelocity: velocity.read.texture,
      uSource: dye.read.texture,
    }, (u) => {
      gl.uniform1f(u.uDt, dt);
      gl.uniform1f(u.uDecay, Math.exp(-DYE_DISSIPATION * dt));
    });
    dye.swap();
  }

  function composite() {
    pass(programs.composite, null, {
      uVelocity: targets.velocity.read.texture,
      uDye: targets.dye.read.texture,
      uPlate: plateTexture,
    }, (u) => {
      gl.uniform2f(u.uCanvasPx, view.pxW, view.pxH);
      gl.uniform1f(u.uDpr, dpr);
      gl.uniform2f(u.uViewOrigin, view.x, view.y);
      gl.uniform2f(u.uBandOrigin, band.left, band.top);
      gl.uniform2f(u.uBandSize, band.width, band.height);
      gl.uniform2f(u.uCell, sim.cellX, sim.cellY);
      gl.uniform2f(u.uPlateOrigin, plate.x, plate.y);
      gl.uniform2f(u.uPlateSize, plate.w, plate.h);
      gl.uniform1f(u.uScrollY, window.scrollY);
      gl.uniform1f(u.uViewH, document.documentElement.clientHeight || 1);
      gl.uniform1f(u.uThreshold, TRAIL_THRESHOLD);
      gl.uniform1f(u.uSoftness, TRAIL_SOFTNESS);
      gl.uniform1f(u.uStrength, DISTORTION_STRENGTH);
      gl.uniform1f(u.uMax, MAX_DISPLACEMENT);
      gl.uniform1f(u.uReveal, REVEAL_THRESHOLD);
      gl.uniform1f(u.uEdge, EDGE_FADE);
      gl.uniform3fv(u.uC0, colors[0]);
      gl.uniform3fv(u.uC1, colors[1]);
      gl.uniform3fv(u.uDebugInk, debugInk);
      gl.uniform1f(u.uDebugOpacity, DEBUG_TRAIL ? DEBUG_OPACITY : 0);
    });
  }

  // ─── Frame loop ─────────────────────────────────────────────
  // Returns Home to the untouched page: clears the fluid and hides the overlay.
  function reset() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    lastTime = 0;
    dyePeak = 0;
    pendingX = pendingY = 0;
    if (gl && targets) clearSimTargets();
    if (wrap && shown) wrap.style.display = "";
    shown = false;
  }

  function kick() {
    if (status !== "ready" || rafId || document.hidden || !homeVisible) return;
    if (dyePeak < TRAIL_THRESHOLD && !pendingX && !pendingY) return;
    rafId = requestAnimationFrame(frame);
  }

  function frame(now) {
    rafId = 0;
    if (!plate.ready || !allowed()) {
      reset();
      return;
    }
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 1 / 30) : 1 / 60;
    lastTime = now;

    splat(dt);
    step(dt);
    composite();
    if (!shown) {
      wrap.style.display = "block";
      shown = true;
    }

    // Once every dye value is below the threshold, the mask is zero everywhere and
    // the overlay draws nothing.
    dyePeak *= Math.exp(-DYE_DISSIPATION * dt);
    if (!pendingX && !pendingY && dyePeak < TRAIL_THRESHOLD) {
      reset();
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  // ─── Input and visibility ───────────────────────────────────
  function insideBand(clientX, clientY) {
    const x = clientX + window.scrollX - band.left;
    const y = clientY + window.scrollY - band.top;
    return x >= 0 && y >= 0 && x < band.width && y < band.height;
  }

  function onPointerMove(event) {
    if (event.pointerType !== "mouse" || status === "disabled") return;
    const x = event.clientX;
    const y = event.clientY;
    const time = event.timeStamp;
    pointerX = x;
    pointerY = y;

    if (!allowed() || !homeVisible) {
      tracking = false;
      return;
    }
    if (status === "idle") {
      if (y < foldHero.getBoundingClientRect().bottom) start();
      return;
    }
    if (status !== "ready") return;

    // The first move after entering only anchors the path; it never pushes.
    if (!insideBand(x, y)) {
      tracking = false;
      return;
    }
    if (tracking) {
      const gap = (time - lastEventTime) / 1000;
      const moveX = x - lastEventX;
      const moveY = y - lastEventY;
      if (gap > 0.1) {
        pointerVelX = pointerVelY = 0;
      } else if (moveX || moveY) {
        const g = Math.max(gap, 1 / 240);
        pointerVelX += (moveX / g - pointerVelX) * 0.5;
        pointerVelY += (moveY / g - pointerVelY) * 0.5;
        pendingX += moveX;
        pendingY += moveY;
      }
    } else {
      pointerVelX = pointerVelY = 0;
    }
    tracking = true;
    lastEventX = x;
    lastEventY = y;
    lastEventTime = time;
    kick();
  }

  function onPointerExit(event) {
    if (event.type === "mouseout" && event.relatedTarget) return;
    tracking = false;
  }

  function onPreferenceChange() {
    if (status === "ready" && !allowed()) reset();
  }

  const visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) homeVisible = entry.isIntersecting;
    if (status === "ready" && !homeVisible) reset();
  });
  visibilityObserver.observe(foldHero);

  on(window, "pointermove", onPointerMove, { passive: true });
  on(document, "mouseout", onPointerExit);
  on(window, "blur", onPointerExit);
  on(document, "visibilitychange", () => {
    if (document.hidden && status === "ready") reset();
  });
  on(finePointer, "change", onPreferenceChange);
  on(reducedMotion, "change", onPreferenceChange);
})();
