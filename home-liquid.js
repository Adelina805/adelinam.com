// Experimental: a small liquid lens that refracts the Home hero around the mouse pointer.
// The real DOM stays untouched underneath; this only draws a visual copy inside a
// lens-sized WebGL canvas that is clipped to the Home band.
(() => {
  // ─── Tuning ─────────────────────────────────────────────────
  // Resting radius of the distortion field in CSS px (diameter ≈ 2×).
  const DISTORTION_RADIUS = 58;
  // Peak displacement of content in CSS px while the pointer rests.
  const DISTORTION_STRENGTH = 8;
  // Share of the remaining distance to the pointer the lens covers per 60fps frame
  // (0–1). Lower values trail further behind the cursor.
  const POINTER_LERP = 0.3;
  // Extra displacement at full speed, as a multiple of DISTORTION_STRENGTH.
  const VELOCITY_INFLUENCE = 0.35;
  // Pointer speed (CSS px per second) at which the movement response peaks.
  const VELOCITY_FULL = 1400;
  // Teardrop deformation at full speed: the trailing side grows by up to 1.6× this,
  // the leading side by 0.4×, and the droplet narrows across the direction of travel.
  const SHAPE_STRETCH = 0.35;
  // Softness of the field's edge. Higher = softer edge and a narrower bending band.
  const EDGE_FALLOFF = 2;
  // Keeps the middle of the droplet clear. 1 = bending peaks halfway out; higher
  // pushes it toward the curved rim (1.5 peaks at ~63% of the radius).
  const CENTER_CLARITY = 1.5;
  // Faint light caught by the upper-left slope of the surface (0 = none, 1 = white).
  const SURFACE_LIGHT = 0.05;
  // How quickly speed-driven strength and stretch relax once the pointer stops
  // (share per 60fps frame, 0–1).
  const SETTLE_SPEED = 0.08;
  // How quickly the lens fades in and out at the edges of Home (share per 60fps frame).
  const PRESENCE_FADE = 0.12;
  // Organic, asymmetric wobble of the outline, as a fraction of the radius.
  const SHAPE_IRREGULARITY = 0.09;
  // How much the outline morphs per CSS px travelled (it holds still at rest).
  const SHAPE_DRIFT = 0.006;
  // Displacement in CSS px below which the real DOM shows through untouched.
  const REVEAL_THRESHOLD = 0.6;
  // Device pixel ratio cap for the lens canvas and the hero copy.
  const MAX_DPR = 2;

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
  const allowed = () => finePointer.matches && !reducedMotion.matches;

  const VERTEX_SHADER = `
    attribute vec2 aPos;
    void main() {
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  // All positions are CSS px relative to the lens canvas' top-left corner.
  const FRAGMENT_SHADER = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    uniform vec2 uRes;
    uniform float uDpr;
    uniform vec2 uCenter;
    uniform vec2 uDir;
    uniform float uStretch;
    uniform float uStrength;
    uniform float uRadius;
    uniform float uIrregular;
    uniform vec4 uPhase;
    uniform float uFalloff;
    uniform float uClarity;
    uniform float uLight;
    uniform float uReveal;
    uniform vec2 uPlateOffset;
    uniform vec2 uPlateSize;
    uniform float uGradY0;
    uniform float uViewH;
    uniform vec3 uC0;
    uniform vec3 uC1;
    uniform sampler2D uPlate;

    void main() {
      vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
      vec2 d = p - uCenter;
      vec2 perp = vec2(-uDir.y, uDir.x);
      float along = dot(d, uDir);

      // Motion pulls the droplet into a teardrop: the trailing side stretches most,
      // the leading side a little, and it narrows slightly across the direction of travel.
      float lead = along / uRadius;
      float stretchAlong = 1.0 + uStretch * (1.0 - 0.6 * lead / sqrt(1.0 + lead * lead));
      float squeezeAcross = sqrt(1.0 + uStretch);
      vec2 q = vec2(along / stretchAlong, dot(d, perp) * squeezeAcross);
      float r = length(q);
      if (r < 0.001) {
        gl_FragColor = vec4(0.0);
        return;
      }

      float a = atan(q.y, q.x);
      float edge = uRadius * (1.0 + uIrregular * (
        0.55 * sin(a + uPhase.x) +
        sin(2.0 * a + uPhase.y) +
        0.6 * sin(3.0 * a + uPhase.z) +
        0.3 * sin(5.0 * a + uPhase.w)
      ));
      float rho = r / edge;
      if (rho >= 1.0) {
        gl_FragColor = vec4(0.0);
        return;
      }

      // Surface slope: zero (with zero slope) at the centre and the edge, pushed toward
      // the curved rim so the middle stays nearly clear.
      float t = pow(rho, uClarity);
      float slope = pow(4.0 * t * (1.0 - t), uFalloff);
      float amount = slope * uStrength;
      float alpha = clamp(amount / uReveal, 0.0, 1.0);
      if (alpha <= 0.0) {
        gl_FragColor = vec4(0.0);
        return;
      }

      vec2 outward = normalize(uDir * (q.x / stretchAlong) + perp * (q.y * squeezeAcross));
      vec2 s = p - outward * amount;
      vec3 grad = mix(uC0, uC1, clamp((s.y + uGradY0) / uViewH, 0.0, 1.0));
      vec2 uv = (s - uPlateOffset) / uPlateSize;
      vec4 plate = texture2D(uPlate, clamp(uv, 0.0, 1.0));
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
        plate = vec4(0.0);
      }
      vec3 color = plate.rgb + grad * (1.0 - plate.a);

      // Faint light caught where the surface tilts toward the upper left.
      float facing = dot(outward, vec2(-0.6, -0.8));
      color = mix(color, vec3(1.0), uLight * slope * slope * smoothstep(0.1, 1.0, facing));

      gl_FragColor = vec4(color * alpha, alpha);
    }
  `;

  let status = "idle"; // idle → starting → ready, or disabled
  let gl = null;
  let canvas = null;
  let wrap = null;
  let texture = null;
  let uniforms = {};
  let resizeObserver = null;
  let themeObserver = null;
  let measureTimer = 0;
  let skipFirstResize = true;
  const cleanups = [];

  const band = { left: 0, top: 0, width: 0, height: 0 };
  const plate = { x: 0, y: 0, w: 1, h: 1, ready: false };
  let dpr = 1;
  let canvasPx = 0;
  let canvasCss = 0;
  let colors = null;
  let isDark = null;

  let homeVisible = false;
  let hasPointer = false;
  let pointerX = 0;
  let pointerY = 0;
  let lensX = 0;
  let lensY = 0;
  let velX = 0;
  let velY = 0;
  let dirX = 1;
  let dirY = 0;
  let motion = 0;
  let presence = 0;
  let travel = 0;
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
    wrap = canvas = gl = texture = null;
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
    isDark = document.body.classList.contains("dark");

    canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: true,
    });
    if (!gl) throw new Error("WebGL unavailable");

    const program = createProgram();
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    for (const name of [
      "uRes", "uDpr", "uCenter", "uDir", "uStretch", "uStrength", "uRadius",
      "uIrregular", "uPhase", "uFalloff", "uClarity", "uLight", "uReveal",
      "uPlateOffset",
      "uPlateSize", "uGradY0", "uViewH", "uC0", "uC1", "uPlate",
    ]) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }

    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uniforms.uPlate, 0);
    gl.disable(gl.BLEND);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL setup failed");

    wrap = document.createElement("div");
    wrap.className = "home-liquid";
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

    kick();
  }

  function createProgram() {
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
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Link failed");
    }
    return program;
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

  function onBodyClassChange() {
    if (status !== "ready") return;
    const dark = document.body.classList.contains("dark");
    if (dark !== isDark) {
      isDark = dark;
      try {
        colors = readColors();
        buildPlate();
      } catch (error) {
        disable();
        return;
      }
    }
    kick();
  }

  // ─── Layout: Home band, lens canvas, hero copy ─────────────
  function scheduleMeasure() {
    if (status !== "ready") return;
    plate.ready = false;
    hideNow();
    clearTimeout(measureTimer);
    measureTimer = setTimeout(() => {
      try {
        measure();
      } catch (error) {
        disable();
        return;
      }
      kick();
    }, 120);
  }

  function measure() {
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const sx = window.scrollX;
    const sy = window.scrollY;

    // Home band: from the sidebar edge to the viewport edge, down to the end of the fold.
    const pageRect = page.getBoundingClientRect();
    const pageStyle = getComputedStyle(page);
    band.left = Math.round(pageRect.left - parseFloat(pageStyle.marginLeft) + sx);
    band.top = Math.round(pageRect.top + sy);
    band.width = Math.max(
      0,
      Math.round(document.documentElement.clientWidth + sx) - band.left,
    );
    band.height = Math.max(
      0,
      Math.round(foldHero.getBoundingClientRect().bottom + sy) - band.top,
    );
    wrap.style.left = `${band.left}px`;
    wrap.style.top = `${band.top}px`;
    wrap.style.width = `${band.width}px`;
    wrap.style.height = `${band.height}px`;

    // Worst case of the shader's outline: the teardrop tail (1.6× stretch) and the
    // sum of its wobble harmonics (2.45× irregularity).
    const reach =
      DISTORTION_RADIUS *
      (1 + 1.6 * SHAPE_STRETCH) *
      (1 + 2.45 * SHAPE_IRREGULARITY);
    canvasPx = Math.ceil((Math.ceil(reach) + 4) * 2 * dpr);
    canvasCss = canvasPx / dpr;
    canvas.width = canvasPx;
    canvas.height = canvasPx;
    canvas.style.width = `${canvasCss}px`;
    canvas.style.height = `${canvasCss}px`;
    gl.viewport(0, 0, canvasPx, canvasPx);

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

    gl.bindTexture(gl.TEXTURE_2D, texture);
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

  // ─── Rendering ──────────────────────────────────────────────
  function showNow() {
    if (shown) return;
    wrap.style.display = "block";
    shown = true;
  }

  function hideNow() {
    presence = 0;
    lastTime = 0;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (wrap && shown) wrap.style.display = "";
    shown = false;
  }

  function kick() {
    if (status !== "ready" || rafId || document.hidden || !homeVisible) return;
    rafId = requestAnimationFrame(frame);
  }

  function frame(now) {
    rafId = 0;
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 1 / 60;
    lastTime = now;
    const frames = dt * 60;
    const ease = (rate) => 1 - Math.pow(1 - rate, frames);

    const bandX = band.left - window.scrollX;
    const bandY = band.top - window.scrollY;
    const inside =
      hasPointer &&
      pointerX >= bandX &&
      pointerX < bandX + band.width &&
      pointerY >= bandY &&
      pointerY < bandY + band.height;
    const target =
      inside &&
      plate.ready &&
      allowed() &&
      !document.body.classList.contains("sidebar-open")
        ? 1
        : 0;

    if (presence === 0) {
      if (!target) {
        hideNow();
        return;
      }
      lensX = pointerX;
      lensY = pointerY;
      velX = velY = motion = 0;
    }

    presence += (target - presence) * ease(PRESENCE_FADE);
    if (!target && presence < 0.01) {
      hideNow();
      return;
    }

    const follow = ease(POINTER_LERP);
    const nextX = lensX + (pointerX - lensX) * follow;
    const nextY = lensY + (pointerY - lensY) * follow;
    const settle = ease(SETTLE_SPEED);
    velX += ((nextX - lensX) / dt - velX) * settle;
    velY += ((nextY - lensY) / dt - velY) * settle;
    travel += Math.hypot(nextX - lensX, nextY - lensY);
    lensX = nextX;
    lensY = nextY;

    const speed = Math.hypot(velX, velY);
    if (speed > 1) {
      dirX = velX / speed;
      dirY = velY / speed;
    }
    motion = Math.min(speed / VELOCITY_FULL, 1);

    const settled =
      Math.abs(target - presence) < 0.002 &&
      Math.abs(pointerX - lensX) < 0.05 &&
      Math.abs(pointerY - lensY) < 0.05 &&
      speed < 2;
    if (settled) {
      presence = target;
      lensX = pointerX;
      lensY = pointerY;
      velX = velY = motion = 0;
    }

    render();

    if (settled) {
      lastTime = 0;
    } else {
      rafId = requestAnimationFrame(frame);
    }
  }

  function render() {
    const sx = window.scrollX;
    const sy = window.scrollY;
    const centerX = lensX + sx;
    const centerY = lensY + sy;
    const half = canvasCss / 2;
    const originX = Math.round((centerX - half) * dpr) / dpr;
    const originY = Math.round((centerY - half) * dpr) / dpr;

    canvas.style.transform = `translate3d(${originX - band.left}px, ${originY - band.top}px, 0)`;
    showNow();

    const stretch = SHAPE_STRETCH * motion;
    const strength =
      DISTORTION_STRENGTH * (1 + VELOCITY_INFLUENCE * motion) * presence;
    const phase = travel * SHAPE_DRIFT;

    gl.uniform2f(uniforms.uRes, canvasPx, canvasPx);
    gl.uniform1f(uniforms.uDpr, dpr);
    gl.uniform2f(uniforms.uCenter, centerX - originX, centerY - originY);
    gl.uniform2f(uniforms.uDir, dirX, dirY);
    gl.uniform1f(uniforms.uStretch, stretch);
    gl.uniform1f(uniforms.uStrength, strength);
    gl.uniform1f(uniforms.uRadius, DISTORTION_RADIUS);
    gl.uniform1f(uniforms.uIrregular, SHAPE_IRREGULARITY);
    gl.uniform4f(
      uniforms.uPhase,
      0.4 + phase * 0.5,
      1.3 + phase,
      4.1 - phase * 0.7,
      2.2 + phase * 1.3,
    );
    gl.uniform1f(uniforms.uFalloff, EDGE_FALLOFF);
    gl.uniform1f(uniforms.uClarity, CENTER_CLARITY);
    gl.uniform1f(uniforms.uLight, SURFACE_LIGHT * presence);
    gl.uniform1f(uniforms.uReveal, REVEAL_THRESHOLD);
    gl.uniform2f(uniforms.uPlateOffset, plate.x - originX, plate.y - originY);
    gl.uniform2f(uniforms.uPlateSize, plate.w, plate.h);
    gl.uniform1f(uniforms.uGradY0, originY - sy);
    gl.uniform1f(uniforms.uViewH, document.documentElement.clientHeight || 1);
    gl.uniform3fv(uniforms.uC0, colors[0]);
    gl.uniform3fv(uniforms.uC1, colors[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ─── Input and visibility ───────────────────────────────────
  function onPointerMove(event) {
    if (event.pointerType !== "mouse" || status === "disabled") return;
    hasPointer = true;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (!allowed() || !homeVisible) return;

    if (status === "idle") {
      if (pointerY < foldHero.getBoundingClientRect().bottom) start();
      return;
    }
    kick();
  }

  function onPointerExit(event) {
    if (event.type === "mouseout" && event.relatedTarget) return;
    hasPointer = false;
    kick();
  }

  function onPreferenceChange() {
    if (status !== "ready") return;
    if (allowed()) {
      kick();
    } else {
      hideNow();
    }
  }

  const visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) homeVisible = entry.isIntersecting;
    if (status !== "ready") return;
    if (homeVisible) {
      kick();
    } else {
      hideNow();
    }
  });
  visibilityObserver.observe(foldHero);

  on(window, "pointermove", onPointerMove, { passive: true });
  on(document, "mouseout", onPointerExit);
  on(window, "blur", onPointerExit);
  on(window, "scroll", kick, { passive: true });
  on(document, "visibilitychange", () => {
    if (document.hidden && status === "ready") hideNow();
  });
  on(finePointer, "change", onPreferenceChange);
  on(reducedMotion, "change", onPreferenceChange);
})();
