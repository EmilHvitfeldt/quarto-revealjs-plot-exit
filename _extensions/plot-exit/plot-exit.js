(function () {
  const STAGGER_MS = 12;
  const FALL_MS = 850;
  const GRAVITY_EASE = "cubic-bezier(0.55, 0.055, 0.675, 0.19)"; // accelerating fall
  const RETURN_EASE = "cubic-bezier(0.25, 0.46, 0.45, 0.94)"; // decelerating float back into place
  const TRAIL_INTERVAL_MS = 70; // how often a ghost copy is dropped while falling
  const TRAIL_FADE_MS = 200; // how long each ghost takes to fade out
  const TRAIL_OPACITY = 0.45; // starting opacity of a freshly dropped ghost

  // Deterministic pseudo-random in [0, 1), seeded by index so a given
  // element always drifts/spins the same way on repeat plays.
  function rand(seed) {
    const x = Math.sin(seed * 999) * 10000;
    return x - Math.floor(x);
  }

  let inlineSvgCounter = 0;

  // R's Cairo svg device numbers ids (glyph-0-0, clip-3, ...) from scratch
  // for every chart, so two inlined charts on the same page collide: a
  // <use href="#glyph-1-1"> in one chart can resolve to a same-numbered but
  // different glyph defined by another chart's <defs>. Prefix every id (and
  // every local reference to it) with a per-inlined-svg namespace so charts
  // never shadow each other.
  function namespaceSvgIds(svg, prefix) {
    const idMap = new Map();
    svg.querySelectorAll("[id]").forEach((el) => {
      const newId = `${prefix}-${el.id}`;
      idMap.set(el.id, newId);
      el.id = newId;
    });
    if (!idMap.size) return;

    const urlRefAttrs = ["clip-path", "mask", "fill", "stroke", "filter"];
    svg.querySelectorAll("*").forEach((el) => {
      for (const attr of ["href", "xlink:href"]) {
        const val = el.getAttribute(attr);
        if (val && val.startsWith("#") && idMap.has(val.slice(1))) {
          el.setAttribute(attr, `#${idMap.get(val.slice(1))}`);
        }
      }
      for (const attr of urlRefAttrs) {
        const val = el.getAttribute(attr);
        if (val && val.includes("url(#")) {
          const updated = val.replace(/url\(#([^)]+)\)/g, (m, id) => (idMap.has(id) ? `url(#${idMap.get(id)})` : m));
          if (updated !== val) el.setAttribute(attr, updated);
        }
      }
      const style = el.getAttribute("style");
      if (style && style.includes("url(#")) {
        const updated = style.replace(/url\(#([^)]+)\)/g, (m, id) => (idMap.has(id) ? `url(#${idMap.get(id)})` : m));
        if (updated !== style) el.setAttribute("style", updated);
      }
    });
  }

  async function inlineSvgImages(container) {
    const imgs = container.querySelectorAll('img[src$=".svg"], img[data-src$=".svg"]');
    for (const img of imgs) {
      const url = img.getAttribute("src") || img.getAttribute("data-src");
      if (!url) continue;
      try {
        const res = await fetch(url);
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        const svg = doc.documentElement;
        const rect = img.getBoundingClientRect();

        if (!svg.getAttribute("viewBox")) {
          const w = svg.getAttribute("width") || rect.width;
          const h = svg.getAttribute("height") || rect.height;
          if (w && h) svg.setAttribute("viewBox", `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
        }
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.display = "block";

        namespaceSvgIds(svg, `gravity-exit-svg-${inlineSvgCounter++}`);

        if (img.className) svg.setAttribute("class", img.className);
        img.replaceWith(svg);
      } catch (e) {
        console.warn("gravity-exit: failed to inline svg", url, e);
      }
    }
  }

  // Every visible mark in the chart: points, gridlines, axis lines, legend
  // keys, and (with the Cairo svg device R uses for `dev: svg`) even each
  // individual text glyph, since that device draws letters as plain paths.
  function collectMarks(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const vbW = vb && vb.width ? vb.width : svg.clientWidth;
    const vbH = vb && vb.height ? vb.height : svg.clientHeight;

    const candidates = svg.querySelectorAll("path, rect, circle, line, polyline, polygon, text, use");
    const marks = [];

    candidates.forEach((el) => {
      if (el.closest("defs, clipPath, symbol")) return;

      if (el.tagName === "rect") {
        const w = parseFloat(el.getAttribute("width"));
        const h = parseFloat(el.getAttribute("height"));
        // Skip full-canvas background rects.
        if (w >= vbW * 0.9 && h >= vbH * 0.9) return;
      }

      marks.push(el);
    });

    return marks;
  }

  // Sample the element's live, mid-transition position (getComputedStyle
  // reflects the interpolated value while a CSS transition is running, not
  // just the target) and drop a fading copy of it there.
  function spawnGhost(svg, el) {
    const ghost = el.cloneNode(false);
    ghost.removeAttribute("id");
    ghost.style.transition = "none";
    ghost.style.transform = getComputedStyle(el).transform;
    ghost.style.transformOrigin = el.style.transformOrigin;
    ghost.style.opacity = String(TRAIL_OPACITY);
    ghost.style.pointerEvents = "none";
    ghost.dataset.gravityGhost = "true";
    svg.insertBefore(ghost, el);
    svg._gravityGhosts.add(ghost);

    requestAnimationFrame(() => {
      ghost.style.transition = `opacity ${TRAIL_FADE_MS}ms linear`;
      ghost.style.opacity = "0";
    });

    const t = setTimeout(() => {
      ghost.remove();
      svg._gravityGhosts.delete(ghost);
    }, TRAIL_FADE_MS + 50);
    svg._timers.push(t);
  }

  function prepareSvg(svg, order, trails, n) {
    if (svg.dataset.gravityReady) return;
    svg.dataset.gravityReady = "true";
    svg._gravityOrder = order;
    svg._gravityTrails = trails;
    svg._gravityN = n;
    svg._gravityGhosts = new Set();

    const vb = svg.viewBox && svg.viewBox.baseVal;
    const svgHeight = vb && vb.height ? vb.height : svg.getBBox().height;

    const marks = collectMarks(svg);

    svg._gravityMarks = marks.map((el, i) => {
      // `transform-box: fill-box` mislocates the rotation origin on <use>
      // elements in some browsers (the referenced glyph's bbox isn't
      // resolved correctly), which can make the net motion go the wrong
      // way. Compute the origin ourselves in the SVG's own user space
      // (the default transform-box) instead of relying on that keyword.
      const bbox = el.getBBox();
      el.style.transformOrigin = `${bbox.x + bbox.width / 2}px ${bbox.y + bbox.height / 2}px`;
      el.style.transition =
        `transform ${FALL_MS}ms ${GRAVITY_EASE}, opacity ${FALL_MS}ms ease-in`;

      return {
        el,
        originalParent: el.parentNode,
        originalNext: el.nextSibling,
        drift: (rand(i + 1) - 0.5) * svgHeight * 0.2,
        spin: (rand(i + 7) - 0.5) * 540,
        fallY: svgHeight * (1.3 + rand(i + 13) * 0.4),
        state: "idle"
      };
    });
  }

  function startFalling(svg) {
    const marks = svg._gravityMarks || [];
    if (!marks.length) return;

    // A reverse pass may still be in flight (user advanced again before it
    // finished); cancel it so its timers don't fight with the forward fall.
    (svg._timers || []).forEach((t) => clearTimeout(t));
    svg._timers = [];

    let order;
    if (svg._gravityOrder === "random") {
      // Fisher-Yates, re-shuffled fresh on every trigger.
      order = marks.slice();
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    } else {
      // Left-to-right sweep, reading as the chart collapsing rather than
      // every element dropping in one simultaneous burst.
      order = marks.slice().sort((a, b) => {
        return a.el.getBoundingClientRect().left - b.el.getBoundingClientRect().left;
      });
    }

    if (svg._gravityN) order = order.slice(0, svg._gravityN);

    // Reversing needs to replay this exact subset (random-order + data-n
    // picks a fresh random subset every call) in the exact reverse sequence,
    // not recompute it later and risk reversing a different random subset.
    svg._gravityLastOrder = order;

    order.forEach((m, i) => {
      // A mark currently mid-return must redirect immediately, not wait for
      // its position in the stagger schedule — only idle/settled marks keep
      // the staggered delay.
      const delay = m.state === "returning" ? 0 : i * STAGGER_MS;
      const t = setTimeout(() => {
        // Escape any clip-path ancestor so the element visibly falls past
        // the panel boundary instead of vanishing at the clip edge.
        svg.appendChild(m.el);
        m.state = "falling";

        // Reassign the forward transition (a mid-return mark still has the
        // return transition applied) before the reflow, so the browser
        // interpolates from the live current value using the right
        // duration/easing rather than the one it was retargeted away from.
        m.el.style.transition =
          `transform ${FALL_MS}ms ${GRAVITY_EASE}, opacity ${FALL_MS}ms ease-in`;
        void m.el.getBoundingClientRect(); // force reflow before transition
        m.el.style.transform = `translate(${m.drift}px, ${m.fallY}px) rotate(${m.spin}deg)`;
        m.el.style.opacity = "0";

        if (svg._gravityTrails) {
          m.trailInterval = setInterval(() => spawnGhost(svg, m.el), TRAIL_INTERVAL_MS);
          svg._timers.push(m.trailInterval);
        }

        const t2 = setTimeout(() => {
          m.state = "fallen";
          if (m.trailInterval) clearInterval(m.trailInterval);
        }, FALL_MS);
        svg._timers.push(t2);
      }, delay);
      svg._timers.push(t);
    });
  }

  function resetFalling(svg) {
    // A forward fall may still be in flight; cancel its timers so this
    // reverse pass is the only thing driving the marks from here.
    (svg._timers || []).forEach((t) => clearTimeout(t));
    svg._timers = [];

    (svg._gravityGhosts || new Set()).forEach((ghost) => ghost.remove());
    if (svg._gravityGhosts) svg._gravityGhosts.clear();

    // Reverse only the marks that actually fell (the exact random-order +
    // data-n subset `startFalling` used), in reverse sequence, mirroring the
    // forward stagger around the end of its timeline. Marks outside that
    // subset were never touched and stay untouched here too.
    const order = (svg._gravityLastOrder || []).slice().reverse();

    order.forEach((m, i) => {
      // A mark currently mid-fall must redirect immediately, not wait for
      // its position in the mirrored stagger schedule — only idle/settled
      // marks keep the staggered delay.
      const delay = m.state === "falling" ? 0 : i * STAGGER_MS;
      const t = setTimeout(() => {
        m.state = "returning";

        // Changing the transform/opacity target while a transition is still
        // running makes the browser interpolate from the current live value,
        // not the nominal fallen end state, so this is safe to call whether
        // the mark already finished falling or is still mid-fall.
        m.el.style.transition =
          `transform ${FALL_MS}ms ${RETURN_EASE}, opacity ${FALL_MS}ms ease-out`;
        m.el.style.transform = "";
        m.el.style.opacity = "";

        if (svg._gravityTrails) {
          m.trailInterval = setInterval(() => spawnGhost(svg, m.el), TRAIL_INTERVAL_MS);
          svg._timers.push(m.trailInterval);
        }

        const t2 = setTimeout(() => {
          m.state = "idle";
          if (m.trailInterval) clearInterval(m.trailInterval);
          m.trailInterval = null;

          // Only safe to reparent back under the (possibly clip-path'd)
          // original parent once the transform is actually back at identity;
          // doing it earlier would clip the mark away mid-flight.
          if (m.originalNext && m.originalNext.parentNode === m.originalParent) {
            m.originalParent.insertBefore(m.el, m.originalNext);
          } else {
            m.originalParent.appendChild(m.el);
          }

          m.el.style.transition =
            `transform ${FALL_MS}ms ${GRAVITY_EASE}, opacity ${FALL_MS}ms ease-in`;
        }, FALL_MS);
        svg._timers.push(t2);
      }, delay);
      svg._timers.push(t);
    });
  }

  async function setupSlide(fragment) {
    if (fragment.dataset.gravitySetup) return;
    fragment.dataset.gravitySetup = "true";

    await inlineSvgImages(fragment);
    const order = fragment.classList.contains("random-order") ? "random" : "sweep";
    const trails = fragment.classList.contains("trails");
    const n = parseInt(fragment.dataset.n, 10) || 0;
    fragment.querySelectorAll("svg").forEach((svg) => prepareSvg(svg, order, trails, n));
  }

  function boot() {
    if (typeof Reveal === "undefined" || !Reveal.isReady()) {
      return setTimeout(boot, 80);
    }

    // Reveal hides every non-current slide with `display: none`, and
    // getBBox() on anything inside a display:none subtree returns an
    // all-zero rect. Setting up a fragment's geometry has to wait until its
    // slide is actually the current (laid-out) one, not run eagerly for
    // every slide at boot.
    function setupCurrentSlide() {
      const current = Reveal.getCurrentSlide();
      if (!current) return;
      current.querySelectorAll(".fragment.gravity-exit").forEach(setupSlide);
    }

    setupCurrentSlide();
    Reveal.on("slidechanged", setupCurrentSlide);

    Reveal.on("fragmentshown", (event) => {
      if (!event.fragment.classList.contains("gravity-exit")) return;
      const svg = event.fragment.querySelector("svg");
      if (svg) startFalling(svg);
    });

    Reveal.on("fragmenthidden", (event) => {
      if (!event.fragment.classList.contains("gravity-exit")) return;
      const svg = event.fragment.querySelector("svg");
      if (svg) resetFalling(svg);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const STAGGER_MS = 12;
  const MORPH_MS = 2500; // shape actually deforms from the mark into a bat
  const BAT_SIZE_MULTIPLIER = 4; // how much bigger the morphed bat is than its normal size
  const FADE_MS = 650; // bat flutters away and fades
  const SAMPLE_N = 36; // points sampled around each shape's outline

  const BAT_PATH_D =
    "M436.73,236.49c-11.76,9.17-19.36,21.55-23.01,36.16-14.58-6.31-29.7-9.72-45.54-5.43-27.27,8.47-45.57,31.98-53.95,58.56-7.78-21.05-17.27-36.47-35.1-49.39-21.05-14.4-41.64-13.85-64.57-3.61-4.06-15.84-12.9-29.24-26.08-38.26-21.83-14.94-52.48-13.46-76.83-2.17-4.22-24.56-19.38-44.25-43.6-51.38-18.89-5.39-36.76-2.42-56.04,3.73,7.49-13.53,15.95-25.54,25.93-36.71l14.01-14.07c35.51-31.5,81.68-48.28,129.11-51.58,8.41,39.04,38.49,70.02,77.23,79.32,5.89,1.41,11.58,2.01,17.78,1.8-2.5-18.93-1.92-37.94,3.71-56.54l18.75,23.27c9.97-4.36,20.92-4.35,30.97-.04l18.84-23.12c5.58,18.19,6.21,37.28,3.76,56.39,11.48.36,22.3-2.18,32.85-6.46,31.98-14.05,54.46-39.97,61.98-74.56,49.53,3.37,97.87,21.4,133.82,55.88,14.08,13.51,25.59,29.03,35.46,46.53-26.34-8.6-51.55-10.65-74.8,5.13-13.65,10.18-22.2,25.18-24.84,42.44-25.68-11.77-56.6-12.95-79.86,4.12Z";

  let inlineSvgCounter = 0;

  // Deterministic pseudo-random in [0, 1), seeded by index so a given
  // element always picks the same bat size/drift/spin on repeat plays.
  function rand(seed) {
    const x = Math.sin(seed * 999) * 10000;
    return x - Math.floor(x);
  }

  // R's Cairo svg device numbers ids (glyph-0-0, clip-3, ...) from scratch
  // for every chart, so two inlined charts on the same page collide: a
  // <use href="#glyph-1-1"> in one chart can resolve to a same-numbered but
  // different glyph defined by another chart's <defs>. Prefix every id (and
  // every local reference to it) with a per-inlined-svg namespace so charts
  // never shadow each other.
  function namespaceSvgIds(svg, prefix) {
    const idMap = new Map();
    svg.querySelectorAll("[id]").forEach((el) => {
      const newId = `${prefix}-${el.id}`;
      idMap.set(el.id, newId);
      el.id = newId;
    });
    if (!idMap.size) return;

    const urlRefAttrs = ["clip-path", "mask", "fill", "stroke", "filter"];
    svg.querySelectorAll("*").forEach((el) => {
      for (const attr of ["href", "xlink:href"]) {
        const val = el.getAttribute(attr);
        if (val && val.startsWith("#") && idMap.has(val.slice(1))) {
          el.setAttribute(attr, `#${idMap.get(val.slice(1))}`);
        }
      }
      for (const attr of urlRefAttrs) {
        const val = el.getAttribute(attr);
        if (val && val.includes("url(#")) {
          const updated = val.replace(/url\(#([^)]+)\)/g, (m, id) => (idMap.has(id) ? `url(#${idMap.get(id)})` : m));
          if (updated !== val) el.setAttribute(attr, updated);
        }
      }
      const style = el.getAttribute("style");
      if (style && style.includes("url(#")) {
        const updated = style.replace(/url\(#([^)]+)\)/g, (m, id) => (idMap.has(id) ? `url(#${idMap.get(id)})` : m));
        if (updated !== style) el.setAttribute("style", updated);
      }
    });
  }

  async function inlineSvgImages(container) {
    const imgs = container.querySelectorAll('img[src$=".svg"], img[data-src$=".svg"]');
    for (const img of imgs) {
      const url = img.getAttribute("src") || img.getAttribute("data-src");
      if (!url) continue;
      try {
        const res = await fetch(url);
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        const svg = doc.documentElement;
        const rect = img.getBoundingClientRect();

        if (!svg.getAttribute("viewBox")) {
          const w = svg.getAttribute("width") || rect.width;
          const h = svg.getAttribute("height") || rect.height;
          if (w && h) svg.setAttribute("viewBox", `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
        }
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.display = "block";

        namespaceSvgIds(svg, `bats-exit-svg-${inlineSvgCounter++}`);

        if (img.className) svg.setAttribute("class", img.className);
        img.replaceWith(svg);
      } catch (e) {
        console.warn("bats-exit: failed to inline svg", url, e);
      }
    }
  }

  // Every visible mark in the chart: points, gridlines, axis lines, legend
  // keys, and (with the Cairo svg device R uses for `dev: svg`) even each
  // individual text glyph, since that device draws letters as plain paths.
  function collectMarks(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const vbW = vb && vb.width ? vb.width : svg.clientWidth;
    const vbH = vb && vb.height ? vb.height : svg.clientHeight;

    const candidates = svg.querySelectorAll("path, rect, circle, line, polyline, polygon, text, use");
    const marks = [];

    candidates.forEach((el) => {
      if (el.closest("defs, clipPath, symbol")) return;

      if (el.tagName === "rect") {
        const w = parseFloat(el.getAttribute("width"));
        const h = parseFloat(el.getAttribute("height"));
        // Skip full-canvas background rects.
        if (w >= vbW * 0.9 && h >= vbH * 0.9) return;
      }

      marks.push(el);
    });

    return marks;
  }

  // Pick a colour for the bat instance that stands in for a given mark: its
  // fill if it has one, else its stroke, else black.
  function markColor(el) {
    const cs = getComputedStyle(el);
    let c = cs.fill;
    if (!c || c === "none" || c === "rgba(0, 0, 0, 0)") c = cs.stroke;
    if (!c || c === "none" || c === "rgba(0, 0, 0, 0)") c = "#000";
    return c;
  }

  // Sample n points evenly spaced (by arc length) around a live <path>'s
  // outline, in that path's own coordinate space.
  function samplePathPoints(pathEl, n) {
    let len;
    try {
      len = pathEl.getTotalLength();
    } catch (e) {
      return null;
    }
    if (!len) return null;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const p = pathEl.getPointAtLength((i / n) * len);
      pts.push({ x: p.x, y: p.y });
    }
    return pts;
  }

  // Fallback outline for marks we can't reduce to a <path>: n points evenly
  // spaced around the perimeter of the mark's own bounding box.
  function bboxOutlinePoints(bbox, n) {
    const { x, y, width: w, height: h } = bbox;
    const perim = 2 * (w + h) || 1;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const d = (i / n) * perim;
      if (d < w) pts.push({ x: x + d, y: y });
      else if (d < w + h) pts.push({ x: x + w, y: y + (d - w) });
      else if (d < 2 * w + h) pts.push({ x: x + w - (d - w - h), y: y + h });
      else pts.push({ x: x, y: y + h - (d - 2 * w - h) });
    }
    return pts;
  }

  // R's Cairo svg device draws points, gridlines, and even individual text
  // glyphs as plain <path> elements, so most marks already have a real
  // outline we can sample directly. Text glyphs are instanced via <use>
  // referencing a <path> in <defs>; resolve that indirection and shift the
  // sampled points by the <use>'s own x/y so they land in the right spot.
  function outlinePointsFor(svg, el, bbox) {
    if (el.tagName === "path") {
      const pts = samplePathPoints(el, SAMPLE_N);
      if (pts) return pts;
    } else if (el.tagName === "use") {
      const href = el.getAttribute("href") || el.getAttribute("xlink:href");
      const target = href ? svg.querySelector(href) : null;
      const innerPath = target ? (target.tagName === "path" ? target : target.querySelector("path")) : null;
      if (innerPath) {
        const pts = samplePathPoints(innerPath, SAMPLE_N);
        if (pts) {
          const ux = parseFloat(el.getAttribute("x")) || 0;
          const uy = parseFloat(el.getAttribute("y")) || 0;
          return pts.map((p) => ({ x: p.x + ux, y: p.y + uy }));
        }
      }
    }
    return bboxOutlinePoints(bbox, SAMPLE_N);
  }

  // Re-centre and rescale a point set into its own local unit space: origin
  // at the shape's own centre, roughly spanning -1..1 on its longer axis.
  // Once every shape lives in this space, placing it on screen is just
  // `translate(cx, cy) scale(radius)`, and two shapes in the same space can
  // be tweened point-for-point.
  function normalizePoints(pts, bbox) {
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    const scale = Math.max(bbox.width, bbox.height, 1) / 2;
    return pts.map((p) => ({ x: (p.x - cx) / scale, y: (p.y - cy) / scale }));
  }

  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      a += p1.x * p2.y - p2.x * p1.y;
    }
    return a / 2;
  }

  // Two closed outlines sampled independently rarely start at "corresponding"
  // points, so a naive index-to-index tween twists the shape into a bowtie
  // mid-morph. Match winding direction, then find the cyclic rotation of
  // `source` that best lines its points up with `target`'s, point for point.
  function alignToTarget(source, target) {
    let src = source;
    if (signedArea(src) * signedArea(target) < 0) src = src.slice().reverse();

    const n = src.length;
    let bestOffset = 0;
    let bestScore = Infinity;
    for (let off = 0; off < n; off++) {
      let score = 0;
      for (let i = 0; i < n; i++) {
        const s = src[(i + off) % n];
        const t = target[i];
        score += (s.x - t.x) ** 2 + (s.y - t.y) ** 2;
      }
      if (score < bestScore) {
        bestScore = score;
        bestOffset = off;
      }
    }
    return src.slice(bestOffset).concat(src.slice(0, bestOffset));
  }

  function pointsToPathD(pts) {
    let d = "";
    for (let i = 0; i < pts.length; i++) {
      d += (i === 0 ? "M" : "L") + pts[i].x.toFixed(3) + "," + pts[i].y.toFixed(3);
    }
    return d + "Z";
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // Computed once (lazily, off-screen) and shared by every mark on every
  // chart: the bat silhouette's own outline, normalized into unit space.
  let batUnitPointsCache = null;
  function getBatUnitPoints() {
    if (batUnitPointsCache) return batUnitPointsCache;
    const tmpSvg = document.createElementNS(SVG_NS, "svg");
    tmpSvg.style.position = "absolute";
    tmpSvg.style.width = "0";
    tmpSvg.style.height = "0";
    tmpSvg.style.overflow = "hidden";
    const tmpPath = document.createElementNS(SVG_NS, "path");
    tmpPath.setAttribute("d", BAT_PATH_D);
    tmpSvg.appendChild(tmpPath);
    document.body.appendChild(tmpSvg);
    const pts = samplePathPoints(tmpPath, SAMPLE_N);
    const bbox = tmpPath.getBBox();
    document.body.removeChild(tmpSvg);
    batUnitPointsCache = normalizePoints(pts, bbox);
    return batUnitPointsCache;
  }

  // Animate an SVG path's `d` attribute by tweening between two point sets
  // frame by frame. CSS can't reliably interpolate arbitrary `d` values
  // across browsers, so this drives the actual shape deformation by hand
  // (the position/scale/rotation/opacity changes alongside it are still
  // done with ordinary CSS transitions on `transform`/`opacity`).
  function tweenShape(el, fromPts, toPts, duration) {
    if (el._morphRAF) cancelAnimationFrame(el._morphRAF);
    // Recorded every frame so a reversal interrupting mid-tween (or right
    // after it finishes) can read back the shape's true current point set
    // instead of assuming it reached `toPts`.
    el._morphCurrentPts = fromPts;
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const e = easeInOutCubic(t);
      const pts = fromPts.map((p, i) => ({
        x: p.x + (toPts[i].x - p.x) * e,
        y: p.y + (toPts[i].y - p.y) * e
      }));
      el.setAttribute("d", pointsToPathD(pts));
      el._morphCurrentPts = pts;
      if (t < 1) {
        el._morphRAF = requestAnimationFrame(frame);
      } else {
        el._morphRAF = null;
      }
    }
    el._morphRAF = requestAnimationFrame(frame);
  }

  function prepareSvg(svg, order, n) {
    if (svg.dataset.batsReady) return;
    svg.dataset.batsReady = "true";
    svg._batsTimers = [];
    svg._batsOrder = order;
    svg._batsN = n;

    const vb = svg.viewBox && svg.viewBox.baseVal;
    const svgWidth = vb && vb.width ? vb.width : svg.clientWidth;
    const svgHeight = vb && vb.height ? vb.height : svg.clientHeight;
    const batUnitPoints = getBatUnitPoints();

    const marks = collectMarks(svg);

    svg._batsMarks = marks.map((el, i) => {
      const bbox = el.getBBox();
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;

      const rawPoints = outlinePointsFor(svg, el, bbox);
      const sourceUnitPoints = alignToTarget(normalizePoints(rawPoints, bbox), batUnitPoints);

      // Size the bat off the mark's own footprint, not a fixed fraction of
      // the whole chart: a tiny scatter point should turn into a bat only a
      // little bigger than itself, or it swallows its neighbours and looks
      // like it landed on the wrong point. Large structural marks (axis
      // lines, gridlines) fall back to the chart-relative size instead,
      // since scaling *those* down to their own footprint would make an
      // already-big element shrink into an oddly small bat.
      const ownRadius = Math.max(bbox.width, bbox.height, 1) / 2;
      const chartRelativeR = svgHeight * (0.025 + rand(i + 3) * 0.0175);
      const ownFootprintR = ownRadius * (1.6 + rand(i + 3) * 1.2);
      const targetRadius = Math.max(Math.min(chartRelativeR, ownFootprintR), svgHeight * 0.0075) * BAT_SIZE_MULTIPLIER;

      return {
        el,
        cx,
        cy,
        ownRadius,
        targetRadius,
        sourceUnitPoints,
        batUnitPoints,
        color: markColor(el),
        drift: (rand(i + 5) - 0.5) * svgWidth * 0.3,
        rise: svgHeight * (0.35 + rand(i + 9) * 0.3),
        spin: (rand(i + 7) - 0.5) * 50,
        proxyEl: null,
        state: "idle"
      };
    });
  }

  // Returns the mark's live proxy, creating one (at the mark's own
  // position/size, invisible) only if nothing is live yet. Reusing an
  // existing proxy rather than tearing it down and rebuilding is what lets
  // morphOne() continue a reverse pass's live shape/position in place
  // instead of snapping it away and fading in a fresh one from scratch.
  function ensureProxy(svg, m) {
    if (m.proxyEl) return m.proxyEl;
    const proxy = document.createElementNS(SVG_NS, "path");
    proxy.setAttribute("d", pointsToPathD(m.sourceUnitPoints));
    proxy.style.fill = m.color;
    proxy.style.pointerEvents = "none";
    // The shape's own points are already centred at its local (0, 0), so
    // translate+scale alone (no transform-origin juggling) places it exactly
    // on the mark it replaces.
    proxy.style.transform = `translate(${m.cx}px, ${m.cy}px) scale(${m.ownRadius})`;
    proxy.style.opacity = "0";
    svg.appendChild(proxy);
    m.proxyEl = proxy;
    return proxy;
  }

  function morphOne(svg, m) {
    // If a reverse pass left a live proxy (mid-unmorph, shape still
    // tweening back), keep driving that same element from wherever it
    // currently sits instead of discarding it — only a truly fresh start
    // (idle, no proxy yet) needs the invisible-small-proxy setup below.
    const freshStart = !m.proxyEl;
    const proxy = ensureProxy(svg, m);
    const fromPts = proxy._morphCurrentPts || m.sourceUnitPoints;

    m.state = "morphing";

    if (freshStart) void proxy.getBoundingClientRect(); // force reflow before transition

    // The proxy starts at the mark's own size and grows to its final bat
    // size over the same duration as the shape tween below, so the size-up
    // and the outline morph read as one motion instead of the size jumping
    // instantly and then the shape unfurling afterwards.
    const CROSSFADE_MS = Math.min(150, MORPH_MS / 2);
    proxy.style.transition = `opacity ${CROSSFADE_MS}ms linear, transform ${MORPH_MS}ms ease-in-out`;
    m.el.style.transition = `opacity ${CROSSFADE_MS}ms linear`;
    requestAnimationFrame(() => {
      proxy.style.opacity = "1";
      proxy.style.transform = `translate(${m.cx}px, ${m.cy}px) scale(${m.targetRadius})`;
      m.el.style.opacity = "0";
    });
    tweenShape(proxy, fromPts, m.batUnitPoints, MORPH_MS);

    const t = setTimeout(() => flyAway(svg, m), MORPH_MS);
    svg._batsTimers.push(t);
  }

  // Dispatch for a forward (fragmentshown) pass: a mark that's mid-unflight
  // is already fully bat-shaped, so it only needs its flight redirected
  // outward again (flyAway, reused on the same proxy) — re-entering the
  // shape morph would be a no-op on the shape but would wrongly restart the
  // position/size tween from scratch. Everything else (idle, or mid-unmorph
  // where the shape itself is still live) goes through morphOne, which
  // continues rather than restarts if a proxy is already live.
  function startOrResumeForward(svg, m) {
    if (m.state === "unflying") {
      flyAway(svg, m);
    } else {
      morphOne(svg, m);
    }
  }

  function flyAway(svg, m) {
    m.state = "flying";
    const proxy = m.proxyEl;
    if (!proxy) return;

    proxy.style.transition = `transform ${FADE_MS}ms ease-in, opacity ${FADE_MS}ms ease-out`;
    void proxy.getBoundingClientRect(); // force reflow before transition

    proxy.style.transform =
      `translate(${m.cx + m.drift}px, ${m.cy - m.rise}px) scale(${m.targetRadius * 1.15}) rotate(${m.spin}deg)`;
    proxy.style.opacity = "0";

    const t = setTimeout(() => {
      m.state = "gone";
    }, FADE_MS);
    svg._batsTimers.push(t);
  }

  function startBats(svg) {
    const marks = svg._batsMarks || [];
    if (!marks.length) return;

    // A reverse pass may still be in flight; cancel it so its timers don't
    // fight with the forward morph/flight.
    (svg._batsTimers || []).forEach((t) => clearTimeout(t));
    svg._batsTimers = [];

    let order;
    if (svg._batsOrder === "random") {
      // Fisher-Yates, re-shuffled fresh on every trigger.
      order = marks.slice();
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    } else {
      // Left-to-right sweep, same reading order as the gravity effect.
      order = marks.slice().sort((a, b) => {
        return a.el.getBoundingClientRect().left - b.el.getBoundingClientRect().left;
      });
    }

    if (svg._batsN) order = order.slice(0, svg._batsN);

    // Reversing needs to replay this exact subset (random-order + data-n
    // picks a fresh random subset every call) in the exact reverse sequence,
    // not recompute it later and risk reversing a different random subset.
    svg._batsLastOrder = order;

    order.forEach((m, i) => {
      // A mark currently mid-reverse must redirect immediately, not wait
      // for its position in the stagger schedule — only idle/settled marks
      // keep the staggered delay.
      const delay = (m.state === "unmorphing" || m.state === "unflying") ? 0 : i * STAGGER_MS;
      const t = setTimeout(() => startOrResumeForward(svg, m), delay);
      svg._batsTimers.push(t);
    });
  }

  // Reverse of flyAway: bring the proxy back from wherever it currently is
  // (mid-flight or fully flown, courtesy of the usual CSS-transition
  // retargeting trick) to the position/size it had right after morphing,
  // undoing the drift/rise/spin/scale-up and the fade-out.
  function reverseFlyAway(svg, m) {
    const proxy = m.proxyEl;
    if (!proxy) return;
    m.state = "unflying";

    proxy.style.transition = `transform ${FADE_MS}ms ease-out, opacity ${FADE_MS}ms ease-in`;
    void proxy.getBoundingClientRect(); // force reflow before transition
    proxy.style.transform = `translate(${m.cx}px, ${m.cy}px) scale(${m.targetRadius})`;
    proxy.style.opacity = "1";
  }

  // Reverse of morphOne: tween the proxy's outline back from wherever it
  // currently is (`_morphCurrentPts`, valid whether the forward morph fully
  // finished or was interrupted mid-tween) to the mark's own outline, shrink
  // it back to the mark's own size, then crossfade the proxy out and the
  // original mark back in at the END of the tween (mirroring how the
  // forward morph crossfades at the START).
  function reverseMorphOne(svg, m) {
    const proxy = m.proxyEl;
    if (!proxy) return;
    m.state = "unmorphing";

    const fromPts = proxy._morphCurrentPts || m.batUnitPoints;

    // Declare both transitions up front (same as the forward morph does) so
    // the later opacity change just lands inside its already-declared
    // window instead of re-declaring `transition` mid-flight, which would
    // risk cutting the still-running transform transition short.
    const CROSSFADE_MS = Math.min(150, MORPH_MS / 2);
    proxy.style.transition = `opacity ${CROSSFADE_MS}ms linear, transform ${MORPH_MS}ms ease-in-out`;
    void proxy.getBoundingClientRect(); // force reflow before transition
    proxy.style.transform = `translate(${m.cx}px, ${m.cy}px) scale(${m.ownRadius})`;
    tweenShape(proxy, fromPts, m.sourceUnitPoints, MORPH_MS);

    m.el.style.transition = `opacity ${CROSSFADE_MS}ms linear`;

    const t = setTimeout(() => {
      proxy.style.opacity = "0";
      m.el.style.opacity = "1";
    }, MORPH_MS - CROSSFADE_MS);
    svg._batsTimers.push(t);

    const t2 = setTimeout(() => {
      if (proxy._morphRAF) cancelAnimationFrame(proxy._morphRAF);
      proxy.remove();
      m.proxyEl = null;
      m.el.style.opacity = "";
      m.state = "idle";
    }, MORPH_MS);
    svg._batsTimers.push(t2);
  }

  function resetBats(svg) {
    // A forward morph/flight may still be in flight; cancel its timers so
    // this reverse pass is the only thing driving the marks from here.
    (svg._batsTimers || []).forEach((t) => clearTimeout(t));
    svg._batsTimers = [];

    // Reverse only the marks that actually left (the exact random-order +
    // data-n subset `startBats` used), in reverse sequence. Marks outside
    // that subset were never touched and stay untouched here too.
    const order = (svg._batsLastOrder || []).slice().reverse();

    order.forEach((m, i) => {
      if (m.state === "idle") return; // never started; nothing to reverse

      // A mark currently mid-flight (still morphing toward, or flying away
      // as, a bat) must redirect immediately, not wait for its position in
      // the mirrored stagger schedule — only already-settled ("gone") marks
      // keep the staggered delay.
      const delay = (m.state === "morphing" || m.state === "flying") ? 0 : i * STAGGER_MS;
      const t = setTimeout(() => {
        if (m.state === "morphing") {
          // Interrupted before it ever took flight: skip straight to
          // un-morphing from its current live shape.
          reverseMorphOne(svg, m);
        } else {
          // state is "flying" or "gone": reverse the flight first, then
          // un-morph once it's back at its just-morphed position/size.
          reverseFlyAway(svg, m);
          const t2 = setTimeout(() => reverseMorphOne(svg, m), FADE_MS);
          svg._batsTimers.push(t2);
        }
      }, delay);
      svg._batsTimers.push(t);
    });
  }

  async function setupSlide(fragment) {
    if (fragment.dataset.batsSetup) return;
    fragment.dataset.batsSetup = "true";

    await inlineSvgImages(fragment);
    const order = fragment.classList.contains("random-order") ? "random" : "sweep";
    const n = parseInt(fragment.dataset.n, 10) || 0;
    fragment.querySelectorAll("svg").forEach((svg) => prepareSvg(svg, order, n));
  }

  function boot() {
    if (typeof Reveal === "undefined" || !Reveal.isReady()) {
      return setTimeout(boot, 80);
    }

    // Reveal hides every non-current slide with `display: none`, and
    // getBBox() on anything inside a display:none subtree returns an
    // all-zero rect. Setting up a fragment's geometry has to wait until its
    // slide is actually the current (laid-out) one, not run eagerly for
    // every slide at boot (which is why bats used to all collapse onto the
    // same spot near the chart's origin).
    function setupCurrentSlide() {
      const current = Reveal.getCurrentSlide();
      if (!current) return;
      current.querySelectorAll(".fragment.bats-exit").forEach(setupSlide);
    }

    setupCurrentSlide();
    Reveal.on("slidechanged", setupCurrentSlide);

    Reveal.on("fragmentshown", (event) => {
      if (!event.fragment.classList.contains("bats-exit")) return;
      const svg = event.fragment.querySelector("svg");
      if (svg) startBats(svg);
    });

    Reveal.on("fragmenthidden", (event) => {
      if (!event.fragment.classList.contains("bats-exit")) return;
      const svg = event.fragment.querySelector("svg");
      if (svg) resetBats(svg);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
