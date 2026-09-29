// Experimental: the cursor stirs a thin layer of liquid over the Home hero. Pointer
// motion injects velocity and dye into a small GPU stable-fluid simulation. The dye
// is never drawn as colour: it is the height of a thin water surface over the recent
// wake, which refracts a visual copy of the hero and catches a little light on its
// slopes. Everywhere else the real DOM shows untouched.
(() => {
  // ─── Tuning ─────────────────────────────────────────────────
  // Velocity/pressure cells along the Home band's short axis.
  const SIM_RESOLUTION = 128;
  // Dye (trail mask) cells along the Home band's short axis.
  const DYE_RESOLUTION = 256;
  // Gaussian blur (sigma, in dye cells) applied to a copy of the dye before it is
  // used as the water surface; smooths small bumps in the wake's outline without
  // touching the simulation. 0 renders the raw dye.
  const DYE_SMOOTHING = 10;
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
  // Soft ceiling on injected fluid speed in CSS px/s. Below it the push is unchanged;
  // above it, faster sweeps widen the push (up to FORCE_SPREAD_MAX × FORCE_RADIUS)
  // instead of sharpening it, so fast flicks don't roll up into small eddies.
  const FLUID_SPEED_MAX = 1000;
  const FORCE_SPREAD_MAX = 2;
  // The push is stretched along the direction of travel, like a finger dragged through
  // water: its reach behind and ahead of the pointer's path, as multiples of its width.
  const FORCE_TAIL = 1;
  const FORCE_LEAD = 1;
  // Vorticity confinement: how much the wake curls.
  const CURL = 0;
  // Velocity blend toward the neighbour average each 60fps frame; damps small eddies.
  const VISCOSITY = 0.18;
  // Decay rates per second. Dye decay sets how long the wake stays visible.
  const VELOCITY_DISSIPATION = 1.5;
  const DYE_DISSIPATION = 3;
  const PRESSURE_ITERATIONS = 20;
  // Share of the previous frame's pressure used to warm-start the solver.
  const PRESSURE_RETAIN = 0.8;
  // Dye level where the wake starts affecting the page, and the ramp above it.
  const TRAIL_THRESHOLD = 0.02;
  const TRAIL_SOFTNESS = 0.25;
  // The dye doubles as the water surface's height. Page displacement in CSS px where
  // that surface is steepest (the flank of a fresh full-speed wake); flat water,
  // including the wake's centre, refracts nothing.
  const REFRACTION_STRENGTH = 10;
  // Seconds of flow: extra displacement along the flow in px = fluid speed in px/s × this.
  const FLOW_DRAG = 0.02;
  // The same dye surface catches a fixed light from the top-left, so the wake stays
  // trackable where there's nothing behind it to refract. Flat water stays clear;
  // the flank facing the light brightens and the flank facing away darkens.
  // How steeply the surface tilts toward the light, relative to the refraction slope.
  const SURFACE_RELIEF = 1.5;
  // Largest opacity of the lit flank (and its glints), and of the shaded flank.
  const SHEEN_HIGHLIGHT = 0.22;
  const SHEEN_SHADOW = 0.12;
  // Largest opacity of the light caught along the wake's crest, reached where the
  // fluid still moves at CREST_SPEED px/s or faster, so it fades before the wake.
  const CREST_HIGHLIGHT = 0.25;
  const CREST_SPEED = 400;
  // Largest displacement of page content in CSS px.
  const MAX_DISPLACEMENT = 36;
  // Displacement in CSS px below which the real DOM shows through untouched.
  const REVEAL_THRESHOLD = 0.5;
  // Device pixel ratio cap for the overlay canvas and the hero copy.
  const MAX_DPR = 2;
  // Distance in CSS px over which the wake fades out at the Home band's edges.
  const EDGE_FADE = 24;
  // Prototype aid: tints the whole wake so its extent can be judged.
  const DEBUG_TRAIL = false;
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

  // Drags the fluid near the pointer's path toward uTarget. The weight is full along
  // the segment's centreline, falls off across it over uRadius, and tapers beyond its
  // ends over uTail (behind) and uLead (ahead), so the push is a long, smooth wake.
  const SPLAT_SHADER = `${SIM_HEADER}
    uniform sampler2D uVelocity;
    uniform vec2 uA;
    uniform vec2 uB;
    uniform float uRadius;
    uniform float uTail;
    uniform float uLead;
    uniform vec2 uTarget;
    uniform float uCoupling;
    float wakeWeight() {
      vec2 p = vUv / uTexel;
      vec2 ab = uB - uA;
      float len = length(ab);
      vec2 dir = len > 1e-3 ? ab / len : normalize(uTarget);
      vec2 rel = p - uA;
      float along = dot(rel, dir);
      float behind = max(-along, 0.0) / uTail;
      float ahead = max(along - len, 0.0) / uLead;
      float across = dot(rel, vec2(-dir.y, dir.x)) / uRadius;
      return exp(-(behind * behind + ahead * ahead + across * across));
    }
    void main() {
      vec2 v = texture(uVelocity, vUv).xy;
      outColor = vec4(mix(v, uTarget, wakeWeight() * uCoupling), 0.0, 1.0);
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
  // always the velocity grid's texel, since velocity is in sim cells per second, so
  // uViscosity only makes sense for velocity.
  const ADVECT_SHADER = `${SIM_HEADER}
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform float uDt;
    uniform float uDecay;
    uniform float uViscosity;
    void main() {
      vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
      vec2 s = texture(uSource, coord).xy;
      if (uViscosity > 0.0) {
        vec2 n =
          texture(uSource, coord - dx()).xy +
          texture(uSource, coord + dx()).xy +
          texture(uSource, coord - dy()).xy +
          texture(uSource, coord + dy()).xy;
        s = mix(s, n * 0.25, uViscosity);
      }
      outColor = vec4(s * uDecay, 0.0, 1.0);
    }
  `;

  // Normalised Gaussian weights for the dye blur's centre tap and its 6 taps each
  // side. The kernel is cut off at 6 cells, so at large DYE_SMOOTHING it is nearly
  // flat across its 13 cells; that broad, even averaging is what rounds off the
  // wake's outline.
  const BLUR_WEIGHTS = (() => {
    const sigma = Math.max(DYE_SMOOTHING, 0.1);
    const w = [0, 1, 2, 3, 4, 5, 6].map((i) => Math.exp((-i * i) / (2 * sigma * sigma)));
    const total = w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0);
    return w.map((v) => (v / total).toFixed(8));
  })();

  // One axis of the dye blur; uStep is one dye cell along that axis.
  const BLUR_SHADER = `#version 300 es
    precision highp float;
    precision highp sampler2D;
    in vec2 vUv;
    out vec4 outColor;
    uniform sampler2D uSource;
    uniform vec2 uStep;
    const float W[7] = float[7](${BLUR_WEIGHTS.join(", ")});
    void main() {
      float sum = W[0] * texture(uSource, vUv).x;
      for (int i = 1; i <= 6; i += 1) {
        vec2 o = uStep * float(i);
        sum += W[i] * (texture(uSource, vUv - o).x + texture(uSource, vUv + o).x);
      }
      outColor = vec4(sum, 0.0, 0.0, 1.0);
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
  // the mask, the hero copy and the viewport-fixed page gradient are refracted by the
  // dye's slope, plus a little drag along the flow, and lit as a water surface.
  // Outside it, alpha is 0 and the real DOM shows through.
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
    uniform vec2 uDyeTexel;
    uniform vec2 uDyeCell;
    uniform float uRefraction;
    uniform float uDrag;
    uniform float uMax;
    uniform float uReveal;
    uniform float uEdge;
    uniform float uRelief;
    uniform float uRadius;
    uniform float uHighlight;
    uniform float uShadow;
    uniform float uCrest;
    uniform float uCrestSpeed;
    uniform vec3 uC0;
    uniform vec3 uC1;
    uniform vec3 uDebugInk;
    uniform float uDebugOpacity;

    // The hero copy over the page gradient at document point s.
    vec3 pageAt(vec2 s) {
      vec2 uv = (s - uPlateOrigin) / uPlateSize;
      vec4 plate = texture(uPlate, clamp(uv, 0.0, 1.0));
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
        plate = vec4(0.0);
      }
      vec3 grad = mix(uC0, uC1, clamp((s.y - uScrollY) / uViewH, 0.0, 1.0));
      return plate.rgb + grad * (1.0 - plate.a);
    }

    void main() {
      vec2 local = vec2(gl_FragCoord.x, uCanvasPx.y - gl_FragCoord.y) / uDpr;
      vec2 p = uViewOrigin + local;
      vec2 bandUv = (p - uBandOrigin) / uBandSize;
      float dye = texture(uDye, bandUv).x;
      float mask = smoothstep(uThreshold, uThreshold + uSoftness, dye);
      // Everything eases to zero at the canvas border so the copy meets the real
      // page without a seam.
      vec2 toEdge = min(local, uCanvasPx / uDpr - local);
      float edge = smoothstep(0.0, uEdge, min(toEdge.x, toEdge.y));
      mask *= edge;
      if (mask <= 0.0) {
        outColor = vec4(0.0);
        return;
      }

      // Height is the raw dye, not the mask, whose ramp would outline the trail.
      float l = texture(uDye, bandUv - vec2(uDyeTexel.x, 0.0)).x;
      float r = texture(uDye, bandUv + vec2(uDyeTexel.x, 0.0)).x;
      float t = texture(uDye, bandUv - vec2(0.0, uDyeTexel.y)).x;
      float b = texture(uDye, bandUv + vec2(0.0, uDyeTexel.y)).x;
      vec2 slope = vec2(r - l, b - t) / (2.0 * uDyeCell);
      vec2 flow = texture(uVelocity, bandUv).xy * uCell;
      vec2 o = (slope * uRefraction - flow * uDrag) * mask;
      float m = length(o);
      if (m > uMax) o *= uMax / m;
      float alpha = clamp(length(o) / uReveal, 0.0, 1.0);

      vec4 copy = vec4(pageAt(p + o) * alpha, alpha);

      // Light on the same surface, over whatever ends up visible here (refracted copy,
      // or the real page where the copy is transparent). A wider Sobel stencil than
      // the refraction's keeps the dye grid's bilinear facets out of the lighting.
      vec2 st = 2.0 * uDyeTexel;
      float nw = texture(uDye, bandUv + vec2(-st.x, -st.y)).x;
      float nn = texture(uDye, bandUv + vec2(0.0, -st.y)).x;
      float ne = texture(uDye, bandUv + vec2(st.x, -st.y)).x;
      float ww = texture(uDye, bandUv + vec2(-st.x, 0.0)).x;
      float ee = texture(uDye, bandUv + vec2(st.x, 0.0)).x;
      float sw = texture(uDye, bandUv + vec2(-st.x, st.y)).x;
      float ss = texture(uDye, bandUv + vec2(0.0, st.y)).x;
      float se = texture(uDye, bandUv + vec2(st.x, st.y)).x;
      vec2 h = 2.0 * uDyeCell;
      vec2 g = vec2(
        (ne + 2.0 * ee + se) - (nw + 2.0 * ww + sw),
        (sw + 2.0 * ss + se) - (nw + 2.0 * nn + ne)
      ) / (8.0 * h);
      vec3 n = normalize(vec3(-g * uRelief, 1.0));

      // Light from the top-left (CSS axes, z toward the viewer). Flat water gives 0.
      vec3 L = normalize(vec3(-0.5, -0.6, 0.62));
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      float shade = dot(n, L) - L.z;
      float lit = 1.0 - exp(-6.0 * max(shade, 0.0));
      float dark = 1.0 - exp(-6.0 * max(-shade, 0.0));
      float glint = max(pow(max(dot(n, H), 0.0), 60.0) - pow(H.z, 60.0), 0.0);

      // The crest (where the surface is most convex, normalised so a fresh full wake's
      // centreline is 1) catches light while the fluid there still moves.
      float lap =
        (ww + ee - 2.0 * dye) / (h.x * h.x) + (nn + ss - 2.0 * dye) / (h.y * h.y);
      float crest = clamp(-lap * uRadius * uRadius * 0.5, 0.0, 1.0);
      crest *= crest * smoothstep(0.0, uCrestSpeed, length(flow));

      float shadowA = uShadow * dark * mask;
      float lightA = clamp(uHighlight * (lit + glint) + uCrest * crest, 0.0, 1.0) * mask;
      copy = vec4(vec3(0.008, 0.067, 0.298) * shadowA, shadowA) + copy * (1.0 - shadowA);
      copy = vec4(vec3(0.96, 0.98, 1.0) * lightA, lightA) + copy * (1.0 - lightA);

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
      blur: createProgram(BLUR_SHADER),
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
      dyeSmooth: createTarget(dyeW, dyeH, gl.R16F, gl.RED),
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

  // The fold ends 20px above the viewport; the fluid still reaches the screen's bottom edge.
  function bandBottom() {
    return Math.max(
      foldHero.getBoundingClientRect().bottom + window.scrollY,
      document.documentElement.clientHeight,
    );
  }

  function measure() {
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const sx = window.scrollX;
    const sy = window.scrollY;

    // Home band (fluid domain): from the sidebar edge to the viewport edge, down to
    // the end of the fold or the first viewport, whichever is lower.
    const pageRect = page.getBoundingClientRect();
    const pageStyle = getComputedStyle(page);
    band.left = Math.round(pageRect.left - parseFloat(pageStyle.marginLeft) + sx);
    band.top = Math.round(pageRect.top + sy);
    band.width = Math.max(
      1,
      Math.round(document.documentElement.clientWidth + sx) - band.left,
    );
    band.height = Math.max(1, Math.round(bandBottom()) - band.top);

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
    const rawFluidSpeed = speed * FORCE_GAIN * strength;
    const fluidSpeed =
      rawFluidSpeed /
      Math.pow(1 + Math.pow(rawFluidSpeed / FLUID_SPEED_MAX, 4), 0.25);
    const spread = Math.min(Math.sqrt(rawFluidSpeed / fluidSpeed), FORCE_SPREAD_MAX);
    const gain = fluidSpeed / speed;
    const endX = pointerX + window.scrollX - band.left;
    const endY = pointerY + window.scrollY - band.top;
    const coupling = 1 - Math.pow(1 - FORCE_COUPLING, dt * 60);
    const { velocity, dye } = targets;
    const setPath = (u, radius) => {
      gl.uniform2f(u.uA, (endX - moveX) / sim.cellX, (endY - moveY) / sim.cellY);
      gl.uniform2f(u.uB, endX / sim.cellX, endY / sim.cellY);
      gl.uniform1f(u.uRadius, radius / Math.max(sim.cellX, sim.cellY));
    };

    pass(programs.splat, velocity.write, {
      uVelocity: velocity.read.texture,
    }, (u) => {
      setPath(u, FORCE_RADIUS * spread);
      const radius = (FORCE_RADIUS * spread) / Math.max(sim.cellX, sim.cellY);
      gl.uniform1f(u.uTail, radius * FORCE_TAIL);
      gl.uniform1f(u.uLead, radius * FORCE_LEAD);
      gl.uniform2f(
        u.uTarget,
        (pointerVelX * gain) / sim.cellX,
        (pointerVelY * gain) / sim.cellY,
      );
      gl.uniform1f(u.uCoupling, coupling);
    });
    velocity.swap();

    pass(programs.dyeSplat, dye.write, { uDye: dye.read.texture }, (u) => {
      setPath(u, FORCE_RADIUS);
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
      gl.uniform1f(u.uViscosity, 1 - Math.pow(1 - VISCOSITY, dt * 60));
    });
    velocity.swap();

    pass(programs.advect, dye.write, {
      uVelocity: velocity.read.texture,
      uSource: dye.read.texture,
    }, (u) => {
      gl.uniform1f(u.uDt, dt);
      gl.uniform1f(u.uDecay, Math.exp(-DYE_DISSIPATION * dt));
      gl.uniform1f(u.uViscosity, 0);
    });
    dye.swap();
  }

  // Blurs the dye into dyeSmooth for rendering only. dye.write is free scratch
  // until the next frame's splat or advection overwrites it.
  function smoothDye() {
    if (DYE_SMOOTHING <= 0) return;
    const { dye, dyeSmooth } = targets;
    const blur = (source, target, stepX, stepY) => {
      pass(programs.blur, target, { uSource: source.texture }, (u) => {
        gl.uniform2f(u.uStep, stepX, stepY);
      });
    };
    blur(dye.read, dye.write, 1 / dyeGrid.w, 0);
    blur(dye.write, dyeSmooth, 0, 1 / dyeGrid.h);
  }

  function composite() {
    pass(programs.composite, null, {
      uVelocity: targets.velocity.read.texture,
      uDye: DYE_SMOOTHING > 0 ? targets.dyeSmooth.texture : targets.dye.read.texture,
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
      gl.uniform2f(u.uDyeTexel, 1 / dyeGrid.w, 1 / dyeGrid.h);
      gl.uniform2f(u.uDyeCell, band.width / dyeGrid.w, band.height / dyeGrid.h);
      gl.uniform1f(u.uRefraction, REFRACTION_STRENGTH * FORCE_RADIUS);
      gl.uniform1f(u.uDrag, FLOW_DRAG);
      gl.uniform1f(u.uMax, MAX_DISPLACEMENT);
      gl.uniform1f(u.uReveal, REVEAL_THRESHOLD);
      gl.uniform1f(u.uEdge, EDGE_FADE);
      gl.uniform1f(u.uRelief, SURFACE_RELIEF * FORCE_RADIUS);
      gl.uniform1f(u.uRadius, FORCE_RADIUS);
      gl.uniform1f(u.uHighlight, SHEEN_HIGHLIGHT);
      gl.uniform1f(u.uShadow, SHEEN_SHADOW);
      gl.uniform1f(u.uCrest, CREST_HIGHLIGHT);
      gl.uniform1f(u.uCrestSpeed, CREST_SPEED);
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
    smoothDye();
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
      if (y + window.scrollY < bandBottom()) start();
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
